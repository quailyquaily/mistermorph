package configtools

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configsettings"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/secref"
)

var envRefPattern = regexp.MustCompile(`\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}`)

// segmentPattern is one segment of a config path: a key, or a list index.
var segmentPattern = regexp.MustCompile(`^[a-z0-9_-]+$`)

// normalizePath checks a dotted config path and returns it in lower case ("" for none).
func normalizePath(raw string) (string, error) {
	path := strings.ToLower(strings.TrimSpace(raw))
	if path == "" {
		return "", nil
	}
	for _, seg := range strings.Split(path, ".") {
		if !segmentPattern.MatchString(seg) {
			return "", fmt.Errorf("invalid config path %q: use dotted keys such as llm.model", strings.TrimSpace(raw))
		}
	}
	return path, nil
}

// denyRule is a part of the config the agent may never change, whatever the user approves:
// config_set refuses the path, anything under it and anything that holds it, before it asks.
type denyRule struct {
	// pattern is a dotted path; "*" matches any one segment.
	pattern string
	reason  string
}

var denyRules = []denyRule{
	{"guard", "it is the guard: approvals, network allowlists, redaction and audit"},
	{"secrets", "it decides which credentials tools may use"},
	{"auth_profiles", "it holds credentials for tools"},
	{"console", "it is the Console's own login and server"},
	{"server.auth_token", "it is the runtime API's token"},
	{"llm.endpoint", "it decides where the model's API key is sent"},
	{"llm.profiles", "profiles hold endpoints and credentials"},
	{"llm.headers", "request headers often carry credentials"},
	{"mcp", "MCP server definitions run commands and hold credentials"},
	{"admins", "it decides who may pair agents"},
	{"*.owners", "it decides who is the owner"},
	{"tools.*.deny_paths", "it protects files from the agent"},
	{"tools.*.injected_env_vars", "it hands environment variables, often credentials, to commands"},
	{"tools.*.elevation", "it lets commands run with raised privileges"},
	{"tools.coder.bypass_approvals", "it skips the coding agents' own approvals"},
	{"logging.redact_keys", "it decides what logs hide"},
	{"workspace_dir", "it decides where file tools may work"},
	{"file_cache_dir", "it decides where file tools may work"},
}

// endpointKeys are keys that name where a channel's or provider's credentials are sent.
var endpointKeys = map[string]bool{"endpoint": true, "endpoints": true, "base_url": true, "service_url": true}

func matchPattern(pattern, path []string) bool {
	if len(pattern) != len(path) {
		return false
	}
	for i := range pattern {
		if pattern[i] != "*" && pattern[i] != path[i] {
			return false
		}
	}
	return true
}

// deniedReason says why the agent may never change path ("" when it may ask to). A path is
// denied when it is a denied part, lies under one, or holds one (so a parent cannot replace it).
func deniedReason(path string) string {
	if path == "" {
		return "the whole config cannot be replaced"
	}
	segs := strings.Split(path, ".")
	_, isField := loadCatalog().field(path)
	for _, key := range configstore.BootstrapKeys {
		if path == key || strings.HasPrefix(path, key+".") || strings.HasPrefix(key, path+".") {
			return "it is settled before the config is read; start morph with --state-dir instead"
		}
	}
	for _, seg := range segs {
		if endpointKeys[seg] {
			return "it decides where credentials are sent"
		}
	}
	for _, rule := range denyRules {
		pattern := strings.Split(rule.pattern, ".")
		for n := 1; n <= len(segs); n++ {
			// path is the denied part, or lies under it.
			if n == len(pattern) && matchPattern(pattern, segs[:n]) {
				return rule.reason
			}
		}
		// path holds the denied part. A registry field is one value and holds no other key.
		if len(segs) < len(pattern) && !isField && matchPattern(pattern[:len(segs)], segs) {
			return rule.reason
		}
	}
	return ""
}

// valueProblem checks a value config_set would write. A secret field takes plain text (stored in
// the system keyring) or one whole environment or AWS Secrets Manager reference; nothing may hold
// config_get's mask, a system keyring reference, or a reference inside other text (config values
// expand ${NAME} anywhere, so one could carry a secret to where it is sent or shown).
func valueProblem(field configsettings.Field, value any) error {
	var problem error
	walkStrings(value, nil, func(keys []string, text string) bool {
		if strings.Contains(text, Mask) {
			problem = fmt.Errorf("the value contains %q, the mask config_get shows in place of a secret; ask the user for the real value", Mask)
			return false
		}
		if strings.Contains(text, "${secret:") {
			problem = fmt.Errorf("the value refers to a system keyring entry (${secret:...}); config_set cannot point a key at a stored secret")
			return false
		}
		if strings.Contains(text, "${") {
			ref, whole := secref.ParseSingleRef(text)
			if field.Sensitive && whole && len(keys) == 0 && (ref.Kind == secref.RefKindEnv || ref.Kind == secref.RefKindAWSSecretsManager) {
				return true
			}
			problem = fmt.Errorf("the value holds a ${...} reference; references are accepted only as the whole value of a secret key (for example ${OPENAI_API_KEY} for llm.api_key)")
			return false
		}
		return true
	})
	if problem != nil {
		return problem
	}
	if field.Kind == configsettings.KindJSON || field.Kind == configsettings.KindStringMap {
		walkKeys(value, func(key string) bool {
			norm := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(key)), "-", "_")
			if isCredentialName(norm) || endpointKeys[norm] || norm == "url" || norm == "headers" || norm == "env" {
				problem = fmt.Errorf("the value sets %q, which config_set does not write inside %s; ask the user to change it in the Console or with morph config set", key, field.Path)
				return false
			}
			return true
		})
	}
	return problem
}

func walkStrings(value any, keys []string, visit func(keys []string, text string) bool) bool {
	switch v := value.(type) {
	case string:
		return visit(keys, v)
	case map[string]any:
		for key, item := range v {
			if !visit(keys, key) || !walkStrings(item, appendSeg(keys, key), visit) {
				return false
			}
		}
	case []any:
		for i, item := range v {
			if !walkStrings(item, appendSeg(keys, fmt.Sprint(i)), visit) {
				return false
			}
		}
	}
	return true
}

func walkKeys(value any, visit func(key string) bool) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			if !visit(key) || !walkKeys(item, visit) {
				return false
			}
		}
	case []any:
		for _, item := range v {
			if !walkKeys(item, visit) {
				return false
			}
		}
	}
	return true
}

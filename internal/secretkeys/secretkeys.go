// Package secretkeys finds the secrets (API keys, tokens) in a config document so the Console can
// offer one field's key for reuse in another. It names which config paths hold secrets, gives each
// stored value a stable identity, masks a value into a short hint, and keeps a small ledger of when
// each key was first saved and in which field.
package secretkeys

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configsettings"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"gopkg.in/yaml.v3"
)

// Secrets that are never offered or revealed: the console's own credentials and the runtime's token.
var excludedPaths = map[string]bool{
	"console.password":      true,
	"console.password_hash": true,
	"server.auth_token":     true,
}

// The secret fields of an LLM profile, under llm.profiles.<name>.
var profileSecretPath = regexp.MustCompile(`^llm\.profiles\.[A-Za-z0-9_-]+\.(api_key|bedrock\.aws_key|bedrock\.aws_secret|bedrock\.aws_session_token|cloudflare\.api_token)$`)

var sensitivePaths = func() map[string]bool {
	paths := map[string]bool{}
	for _, fields := range [][]configsettings.Field{configsettings.AgentFields(), configsettings.ConsoleFields(), configsettings.SystemFields()} {
		for _, field := range fields {
			if field.Sensitive {
				paths[field.Path] = true
			}
		}
	}
	return paths
}()

// IsSecretPath reports whether path is a secret field that may be revealed or reused: one the
// settings mark sensitive, or an LLM profile's credential.
func IsSecretPath(path string) bool {
	if path == "" || excludedPaths[path] {
		return false
	}
	return profileSecretPath.MatchString(path) || sensitivePaths[path]
}

// Field is one secret field set in a config document. Raw is its value as written: a reference
// such as ${secret:...} or ${OPENAI_API_KEY}, or the key itself in plain text.
type Field struct {
	Path string
	Raw  string
}

// Collect returns the secret fields set in doc, in document order.
func Collect(doc *yaml.Node) []Field {
	if doc == nil {
		return nil
	}
	root := doc
	if root.Kind == yaml.DocumentNode {
		if len(root.Content) == 0 {
			return nil
		}
		root = root.Content[0]
	}
	var out []Field
	var visit func(node *yaml.Node, prefix string)
	visit = func(node *yaml.Node, prefix string) {
		if node == nil || node.Kind != yaml.MappingNode {
			return
		}
		for i := 0; i+1 < len(node.Content); i += 2 {
			path := node.Content[i].Value
			if prefix != "" {
				path = prefix + "." + path
			}
			value := node.Content[i+1]
			if value.Kind == yaml.ScalarNode {
				if raw := strings.TrimSpace(value.Value); raw != "" && IsSecretPath(path) {
					out = append(out, Field{Path: path, Raw: raw})
				}
				continue
			}
			visit(value, path)
		}
	}
	visit(root, "")
	return out
}

// CollectBytes is Collect for a config file's contents; a file that does not parse has none.
func CollectBytes(raw []byte) []Field {
	var doc yaml.Node
	if len(raw) == 0 || yaml.Unmarshal(raw, &doc) != nil {
		return nil
	}
	return Collect(&doc)
}

// Kind names where a raw value keeps its secret: "os" (the system's secret storage), "env",
// "aws" (AWS Secrets Manager) or "file" (in config.yaml as plain text).
func Kind(raw string) string {
	ref, ok := secref.ParseSingleRef(raw)
	if !ok {
		return "file"
	}
	switch ref.Kind {
	case secref.RefKindOS:
		return "os"
	case secref.RefKindEnv:
		return "env"
	case secref.RefKindAWSSecretsManager:
		return "aws"
	}
	return "file"
}

// Identity names the key a raw value holds, for the ledger: the reference itself, or a hash of a
// plain-text key (never the key).
func Identity(raw string) string {
	raw = strings.TrimSpace(raw)
	if ref, ok := secref.ParseSingleRef(raw); ok {
		switch ref.Kind {
		case secref.RefKindOS:
			return "os:" + ref.SecretID
		case secref.RefKindEnv:
			return "env:" + ref.EnvName
		case secref.RefKindAWSSecretsManager:
			id := "aws:" + ref.SecretID
			if ref.Field != "" {
				id += "#" + ref.Field
			}
			return id
		}
	}
	return "file:" + ValueHash(raw)
}

// ValueHash is a short, stable hash of a secret value, used to tell keys apart without keeping them.
func ValueHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:24]
}

// hintPrefix matches a key's readable prefix, such as "sk-proj-" or "xoxb-".
var hintPrefix = regexp.MustCompile(`^[A-Za-z]{2,8}(?:[-_][A-Za-z]{2,8})*[-_]`)

// hintMinLength is the shortest value whose last characters are shown; a shorter one, such as a
// password, shows none.
const hintMinLength = 16

// hintLeadLength is how many leading characters stand in for a key with no readable prefix.
const hintLeadLength = 4

// Hint masks a secret value into something to recognize it by: its readable prefix, or its first
// four characters when it has none, and its last four ("sk-proj-…a1b2", "1234…Dsaw"); only "…"
// for a short value.
func Hint(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) < hintMinLength {
		return "…"
	}
	prefix := hintPrefix.FindString(string(runes))
	if prefix == "" || len([]rune(prefix)) > len(runes)-8 {
		prefix = string(runes[:hintLeadLength])
	}
	return prefix + "…" + string(runes[len(runes)-4:])
}

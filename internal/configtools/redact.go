package configtools

import (
	"os"
	"strconv"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"gopkg.in/yaml.v3"
)

// Mask stands in for a secret in everything config_get and config_set return. config_set refuses
// a value that contains it, so a value read back cannot overwrite the secret it hides.
const Mask = "********"

// Where a secret's value comes from, as config_get reports it (never the value, an environment
// variable's name or a secret id).
const (
	SourceLiteral       = "literal"             // written in the config as plain text
	SourceEnv           = "env"                 // a ${NAME} environment variable reference
	SourceSecretStore   = "secret_store"        // a ${secret:...} reference to the system keyring
	SourceAWS           = "aws_secrets_manager" // a ${aws-sm:...} reference
	SourceTemplate      = "template"            // text with references inside it
	SourceEnvOverride   = "env_override"        // the MISTER_MORPH_* variable of the key
	secretValueMinChars = 8
)

// SecretInfo says whether a secret is set and where from.
type SecretInfo struct {
	Set    bool   `json:"set"`
	Source string `json:"source,omitempty"`
}

// masker renders config nodes with every secret replaced. A secret is: a registry field marked
// Sensitive, anything under secrets.* or auth_profiles.*, a key named like a credential (api_key,
// *_token, *_secret, password, ...), any header or environment value, a ${secret:...} or
// ${aws-sm:...} reference anywhere, and any value that holds the value of one of those (a copy, or
// a YAML alias of it).
type masker struct {
	sensitiveFields map[string]bool
	secretNodes     map[*yaml.Node]bool
	secretValues    []string
}

func newMasker(root *yaml.Node, c *catalog) *masker {
	m := &masker{sensitiveFields: map[string]bool{}, secretNodes: map[*yaml.Node]bool{}}
	for path, field := range c.fields {
		if field.Sensitive {
			m.sensitiveFields[path] = true
			if value, ok := os.LookupEnv(fieldEnvName(path)); ok {
				m.addSecretValue(value)
			}
		}
	}
	m.collect(root, nil, false)
	return m
}

func (m *masker) addSecretValue(value string) {
	value = strings.TrimSpace(value)
	if len(value) >= secretValueMinChars {
		m.secretValues = append(m.secretValues, value)
	}
}

// collect marks the nodes inside secret paths and remembers the values they resolve to.
func (m *masker) collect(node *yaml.Node, segs []string, secret bool) {
	if node == nil {
		return
	}
	if node.Kind == yaml.DocumentNode {
		for _, child := range node.Content {
			m.collect(child, segs, secret)
		}
		return
	}
	secret = secret || m.isSecretPath(segs)
	if node.Kind == yaml.AliasNode {
		if secret && node.Alias != nil {
			m.collect(node.Alias, segs, true)
		}
		return
	}
	if secret {
		if m.secretNodes[node] {
			return
		}
		m.secretNodes[node] = true
	}
	switch node.Kind {
	case yaml.ScalarNode:
		if secret {
			m.rememberScalar(node.Value)
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(node.Content); i += 2 {
			m.collect(node.Content[i+1], appendSeg(segs, node.Content[i].Value), secret)
		}
	case yaml.SequenceNode:
		for i, child := range node.Content {
			m.collect(child, appendSeg(segs, strconv.Itoa(i)), secret)
		}
	}
}

// rememberScalar keeps what a secret scalar resolves to without asking a secret store: its plain
// text, or its environment variables' values.
func (m *masker) rememberScalar(raw string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return
	}
	if !strings.Contains(raw, "${") {
		m.addSecretValue(raw)
		return
	}
	if expanded, _ := configutil.ExpandStrictEnv(raw); expanded != raw {
		m.addSecretValue(expanded)
		for _, match := range envRefPattern.FindAllStringSubmatch(raw, -1) {
			if value, ok := os.LookupEnv(match[1]); ok {
				m.addSecretValue(value)
			}
		}
	}
}

func appendSeg(segs []string, seg string) []string {
	out := make([]string, len(segs), len(segs)+1)
	copy(out, segs)
	return append(out, seg)
}

// isSecretPath reports whether the value at segs is a secret by where it is.
func (m *masker) isSecretPath(segs []string) bool {
	if len(segs) == 0 {
		return false
	}
	norm := make([]string, len(segs))
	for i, seg := range segs {
		norm[i] = strings.ReplaceAll(strings.ToLower(strings.TrimSpace(seg)), "-", "_")
	}
	if m.sensitiveFields[strings.Join(norm, ".")] {
		return true
	}
	if norm[0] == "secrets" || norm[0] == "auth_profiles" {
		return true
	}
	for i, seg := range norm {
		if isCredentialName(seg) {
			return true
		}
		if i > 0 && (norm[i-1] == "headers" || norm[i-1] == "env") {
			return true
		}
		if seg == "value" && containsSeg(norm[:i], "injected_env_vars") {
			return true
		}
	}
	return false
}

func containsSeg(segs []string, want string) bool {
	for _, seg := range segs {
		if seg == want {
			return true
		}
	}
	return false
}

// isCredentialName reports whether a key names a credential.
func isCredentialName(key string) bool {
	switch key {
	case "secret", "secrets", "password", "passwd", "passphrase", "token", "authorization", "cookie",
		"credential", "credentials", "apikey", "key", "password_hash", "private_key":
		return true
	}
	for _, suffix := range []string{"_secret", "_password", "_passphrase", "_token", "_key", "_apikey", "_credential", "_credentials", "_cookie"} {
		if strings.HasSuffix(key, suffix) {
			return true
		}
	}
	return false
}

// isSecretScalar reports whether a scalar is a secret by what it holds.
func (m *masker) isSecretScalar(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	if strings.Contains(raw, "${secret:") || strings.Contains(raw, "${aws-sm:") {
		return true
	}
	for _, secret := range m.secretValues {
		if strings.Contains(raw, secret) {
			return true
		}
	}
	return false
}

// render turns node into plain values with every secret masked.
func (m *masker) render(node *yaml.Node, segs []string) any {
	if node == nil {
		return nil
	}
	if node.Kind == yaml.DocumentNode {
		if len(node.Content) == 0 {
			return nil
		}
		return m.render(node.Content[0], segs)
	}
	secret := m.secretNodes[node] || m.isSecretPath(segs)
	if node.Kind == yaml.AliasNode {
		if node.Alias == nil {
			return nil
		}
		secret = secret || m.secretNodes[node.Alias]
		if !secret {
			return m.render(node.Alias, segs)
		}
		node = node.Alias
	}
	if secret {
		return maskNode(node, 0)
	}
	switch node.Kind {
	case yaml.ScalarNode:
		if m.isSecretScalar(node.Value) {
			return MaskedText(node.Value)
		}
		return scalarValue(node)
	case yaml.MappingNode:
		out := make(map[string]any, len(node.Content)/2)
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := node.Content[i].Value
			out[key] = m.render(node.Content[i+1], appendSeg(segs, key))
		}
		return out
	case yaml.SequenceNode:
		out := make([]any, 0, len(node.Content))
		for i, child := range node.Content {
			out = append(out, m.render(child, appendSeg(segs, strconv.Itoa(i))))
		}
		return out
	}
	return nil
}

// maskNode keeps a secret value's shape (keys, list length) and masks every scalar in it.
func maskNode(node *yaml.Node, depth int) any {
	if node == nil || depth > 64 {
		return nil
	}
	switch node.Kind {
	case yaml.AliasNode:
		return maskNode(node.Alias, depth+1)
	case yaml.ScalarNode:
		if node.ShortTag() == "!!null" {
			return nil
		}
		return MaskedText(node.Value)
	case yaml.MappingNode:
		out := make(map[string]any, len(node.Content)/2)
		for i := 0; i+1 < len(node.Content); i += 2 {
			out[node.Content[i].Value] = maskNode(node.Content[i+1], depth+1)
		}
		return out
	case yaml.SequenceNode:
		out := make([]any, 0, len(node.Content))
		for _, child := range node.Content {
			out = append(out, maskNode(child, depth+1))
		}
		return out
	}
	return nil
}

// MaskedText is a secret scalar as config_get shows it: "" when it is empty, otherwise Mask and
// where it comes from, such as "******** (env)".
func MaskedText(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	return Mask + " (" + SecretSource(raw) + ")"
}

// SecretSource names where a secret scalar's value comes from.
func SecretSource(raw string) string {
	raw = strings.TrimSpace(raw)
	if ref, ok := secref.ParseSingleRef(raw); ok {
		switch ref.Kind {
		case secref.RefKindEnv:
			return SourceEnv
		case secref.RefKindOS:
			return SourceSecretStore
		case secref.RefKindAWSSecretsManager:
			return SourceAWS
		}
	}
	if strings.Contains(raw, "${") {
		return SourceTemplate
	}
	return SourceLiteral
}

func scalarValue(node *yaml.Node) any {
	switch node.ShortTag() {
	case "!!null":
		return nil
	case "!!str":
		return node.Value
	case "!!bool", "!!int", "!!float":
		var value any
		if err := node.Decode(&value); err == nil {
			return value
		}
	}
	return node.Value
}

func fieldEnvName(path string) string {
	return "MISTER_MORPH_" + strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(path))
}

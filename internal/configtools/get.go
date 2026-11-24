package configtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configbootstrap"
	"github.com/quailyquaily/mistermorph/internal/configsettings"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"gopkg.in/yaml.v3"
)

// Options say where the config is and how config_set stores secrets.
type Options struct {
	// ConfigPath is the config both tools work on: agent.db's (configstore.DBConfigPath) or a file.
	ConfigPath string
	// StateDir is the state folder, for the ledger of saved keys; empty skips it.
	StateDir string
	// SecretStore keeps the secrets config_set saves (the system keyring). Nil: config_set refuses
	// a plain-text secret and accepts only an environment or AWS Secrets Manager reference.
	SecretStore secref.OSStore
}

// KeyInfo is one config key as config_get returns it.
type KeyInfo struct {
	Path string `json:"path"`
	// Set: the config has the key; otherwise Default applies.
	Set bool `json:"set"`
	// Value is the key's value as written (${VAR} not expanded), with secrets masked; null when
	// it is not set.
	Value any `json:"value"`
	// Secret, for a secret key: whether it is set and where from. Its value is never shown.
	Secret    *SecretInfo `json:"secret,omitempty"`
	Type      string      `json:"type"`
	Default   any         `json:"default,omitempty"`
	ApplyMode string      `json:"apply_mode,omitempty"`
	Sensitive bool        `json:"sensitive"`
	// Settable: config_set may change the key (still only after the user approves).
	Settable          bool     `json:"settable"`
	NotSettableReason string   `json:"not_settable_reason,omitempty"`
	AllowedValues     []string `json:"allowed_values,omitempty"`
	Min               *float64 `json:"min,omitempty"`
	Max               *float64 `json:"max,omitempty"`
	// EnvOverride names the MISTER_MORPH_* environment variable that overrides the key.
	EnvOverride string `json:"env_override,omitempty"`
	Comment     string `json:"comment,omitempty"`
}

// SectionInfo is one top-level name in config_get's overview.
type SectionInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Kind is "section" (holds keys) or "key".
	Kind string `json:"kind"`
	Set  bool   `json:"set"`
}

// document is the config as written, with what config_get needs to show it.
type document struct {
	raw    []byte
	root   *yaml.Node
	masker *masker
	cat    *catalog
	source string
}

// errConfigInvalid hides a parse error, which can quote the config's text.
var errConfigInvalid = errors.New("the config is not valid YAML; ask the user to fix it (morph config edit)")

func loadDocument(path string) (*document, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("this runtime has no config to read")
	}
	raw, err := configstore.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("the config could not be read: %s", safeError(err))
		}
		raw = nil
	}
	doc, err := configbootstrap.LoadDocumentBytes(raw)
	if err != nil {
		return nil, errConfigInvalid
	}
	root, err := configbootstrap.DocumentMapping(doc)
	if err != nil {
		return nil, errConfigInvalid
	}
	cat := loadCatalog()
	return &document{raw: raw, root: root, masker: newMasker(root, cat), cat: cat, source: configstore.Source(path)}, nil
}

// safeError is an error's text with anything that looks like a value left out.
func safeError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, os.ErrPermission) {
		return "permission denied"
	}
	text := err.Error()
	if strings.Contains(text, "${") || len(text) > 200 {
		return "unexpected error"
	}
	return text
}

// lookup finds the node at segs: mapping keys (any case), or a list's index.
func lookup(root *yaml.Node, segs []string) *yaml.Node {
	node := root
	for _, seg := range segs {
		if node != nil && node.Kind == yaml.AliasNode {
			node = node.Alias
		}
		if node == nil {
			return nil
		}
		switch node.Kind {
		case yaml.MappingNode:
			node = configbootstrap.FindMappingValue(node, seg)
		case yaml.SequenceNode:
			i, err := strconv.Atoi(seg)
			if err != nil || i < 0 || i >= len(node.Content) {
				return nil
			}
			node = node.Content[i]
		default:
			return nil
		}
	}
	return node
}

func splitPath(path string) []string {
	if path == "" {
		return nil
	}
	return strings.Split(path, ".")
}

// Get is config_get: the overview without a path, the keys of a section, or one key.
func Get(opts Options, rawPath string) (map[string]any, error) {
	path, err := normalizePath(rawPath)
	if err != nil {
		return nil, err
	}
	doc, err := loadDocument(opts.ConfigPath)
	if err != nil {
		return nil, err
	}
	if path == "" {
		return doc.overview(), nil
	}
	if doc.cat.isKey(path) {
		return map[string]any{"config": doc.source, "key": doc.keyInfo(path)}, nil
	}
	node := lookup(doc.root, splitPath(path))
	if doc.cat.isSection(path) || (node != nil && resolve(node).Kind == yaml.MappingNode && doc.cat.hasKeyUnder(path)) {
		return map[string]any{
			"config":      doc.source,
			"section":     path,
			"description": doc.describeSection(path),
			"keys":        doc.keysUnder(path),
		}, nil
	}
	if node != nil {
		return map[string]any{"config": doc.source, "key": doc.valueInfo(path, node)}, nil
	}
	return nil, fmt.Errorf("%s is not a config key or section; call config_get without a path to list the sections", path)
}

func resolve(node *yaml.Node) *yaml.Node {
	for i := 0; node != nil && node.Kind == yaml.AliasNode && i < 16; i++ {
		node = node.Alias
	}
	return node
}

func (d *document) overview() map[string]any {
	names := append([]string(nil), d.cat.topLevel...)
	known := map[string]bool{}
	for _, name := range names {
		known[name] = true
	}
	var extra []string
	for i := 0; i+1 < len(d.root.Content); i += 2 {
		name := strings.ToLower(strings.TrimSpace(d.root.Content[i].Value))
		if name != "" && !known[name] {
			known[name] = true
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	names = append(names, extra...)
	sections := make([]SectionInfo, 0, len(names))
	for _, name := range names {
		kind := "section"
		if !d.cat.isSection(name) {
			kind = "key"
		}
		node := configbootstrap.FindMappingValue(d.root, name)
		if node != nil && kind == "key" && resolve(node).Kind == yaml.MappingNode && !d.cat.isKey(name) {
			kind = "section"
		}
		sections = append(sections, SectionInfo{
			Name:        name,
			Description: d.cat.sectionDescription(name),
			Kind:        kind,
			Set:         node != nil,
		})
	}
	return map[string]any{
		"config":   d.source,
		"sections": sections,
		"note": "Call config_get with a section (such as llm) to list its keys with their values, types, defaults and comments, " +
			"or with a key (such as llm.model). Secrets are never shown: they read " + Mask + " with where they come from.",
	}
}

func (d *document) describeSection(path string) string {
	if !strings.Contains(path, ".") {
		return d.cat.sectionDescription(path)
	}
	first, _, _ := strings.Cut(d.cat.comment(path), "\n")
	return strings.TrimSpace(first)
}

// keysUnder lists the known keys under section, then what the config sets there that is not a
// known key (each at its shallowest unknown path, masked as a whole where it is secret).
func (d *document) keysUnder(section string) []KeyInfo {
	paths := d.cat.keysUnder(section)
	out := make([]KeyInfo, 0, len(paths))
	listed := map[string]bool{}
	for _, path := range paths {
		listed[path] = true
		out = append(out, d.keyInfo(path))
	}
	node := lookup(d.root, splitPath(section))
	d.collectUnknown(node, section, listed, &out)
	return out
}

func (d *document) collectUnknown(node *yaml.Node, path string, listed map[string]bool, out *[]KeyInfo) {
	node = resolve(node)
	if node == nil || node.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := strings.ToLower(strings.TrimSpace(node.Content[i].Value))
		if key == "" {
			continue
		}
		child := key
		if path != "" {
			child = path + "." + key
		}
		if listed[child] {
			continue
		}
		if d.cat.hasKeyUnder(child) {
			d.collectUnknown(node.Content[i+1], child, listed, out)
			continue
		}
		listed[child] = true
		*out = append(*out, d.valueInfo(child, node.Content[i+1]))
	}
}

// keyInfo describes a known key.
func (d *document) keyInfo(path string) KeyInfo {
	segs := splitPath(path)
	node := lookup(d.root, segs)
	field, isField := d.cat.field(path)
	sensitive := (isField && field.Sensitive) || d.masker.isSecretPath(segs)
	info := KeyInfo{
		Path:      path,
		Set:       node != nil,
		Sensitive: sensitive,
		Comment:   d.cat.comment(path),
	}
	if isField {
		info.Type = string(field.Kind)
		info.ApplyMode = string(field.ApplyMode)
		info.AllowedValues = field.Enum
		info.Min, info.Max = field.Min, field.Max
	} else {
		info.Type = nodeType(node)
	}
	if value, ok := d.cat.defaultValue(path); ok {
		if sensitive {
			info.Default = MaskedText(fmt.Sprint(value))
		} else {
			info.Default = value
		}
	}
	if node != nil {
		info.Value = d.masker.render(node, segs)
	}
	if sensitive {
		info.Secret = secretInfo(node)
		if info.Secret.Set {
			info.Value = Mask
		} else if node != nil {
			info.Value = ""
		}
	}
	envName := fieldEnvName(path)
	if _, ok := os.LookupEnv(envName); ok {
		info.EnvOverride = envName
		if sensitive {
			info.Secret = &SecretInfo{Set: true, Source: SourceEnvOverride}
		}
	}
	info.Settable, info.NotSettableReason = settable(path, isField, info.EnvOverride)
	return info
}

// valueInfo describes what the config sets at a path that is not a known key.
func (d *document) valueInfo(path string, node *yaml.Node) KeyInfo {
	segs := splitPath(path)
	sensitive := d.masker.isSecretPath(segs) || d.masker.secretNodes[node] || d.masker.secretNodes[resolve(node)]
	info := KeyInfo{
		Path:      path,
		Set:       true,
		Value:     d.masker.render(node, segs),
		Type:      nodeType(node),
		Sensitive: sensitive,
		Comment:   d.cat.comment(path),
	}
	if sensitive && resolve(node).Kind == yaml.ScalarNode {
		info.Secret = secretInfo(node)
		if info.Secret.Set {
			info.Value = Mask
		} else {
			info.Value = ""
		}
	}
	info.Settable, info.NotSettableReason = settable(path, false, "")
	return info
}

func secretInfo(node *yaml.Node) *SecretInfo {
	node = resolve(node)
	if node == nil {
		return &SecretInfo{}
	}
	if node.Kind != yaml.ScalarNode {
		return &SecretInfo{Set: len(node.Content) > 0, Source: SourceLiteral}
	}
	raw := strings.TrimSpace(node.Value)
	if raw == "" || node.ShortTag() == "!!null" {
		return &SecretInfo{}
	}
	return &SecretInfo{Set: true, Source: SecretSource(raw)}
}

func settable(path string, isField bool, envOverride string) (bool, string) {
	if reason := deniedReason(path); reason != "" {
		return false, "only the user can change it: " + reason
	}
	if !isField {
		return false, "it is not a field config_set changes; the user can change it in the Console or with morph config set"
	}
	if envOverride != "" {
		return false, "the environment variable " + envOverride + " sets it"
	}
	return true, ""
}

func nodeType(node *yaml.Node) string {
	node = resolve(node)
	if node == nil {
		return "unknown"
	}
	switch node.Kind {
	case yaml.MappingNode:
		return "mapping"
	case yaml.SequenceNode:
		return "list"
	case yaml.ScalarNode:
		switch node.ShortTag() {
		case "!!bool":
			return string(configsettings.KindBool)
		case "!!int":
			return string(configsettings.KindInt)
		case "!!float":
			return string(configsettings.KindFloat)
		case "!!null":
			return "null"
		}
		return string(configsettings.KindString)
	}
	return "unknown"
}

// GetTool is config_get.
type GetTool struct {
	opts func() Options
}

// GetToolName and SetToolName are the tools' names.
const (
	GetToolName = "config_get"
	SetToolName = "config_set"
)

// NewGetTool returns config_get reading the config opts name.
func NewGetTool(opts Options) *GetTool {
	return &GetTool{opts: func() Options { return opts }}
}

func (t *GetTool) Name() string { return GetToolName }

// Deferred: config_get stays out of requests until the model finds it with tool_search.
func (t *GetTool) Deferred() bool { return true }

// ParallelSafe: config_get only reads.
func (t *GetTool) ParallelSafe() bool { return true }

func (t *GetTool) Description() string {
	return "Read the agent's own config (settings) and its structure. Without path: the top-level sections, each with a description. " +
		"With a section path (llm, tools.bash, telegram): every key under it. With a key path (llm.model): that key. " +
		"Each key comes with its current value as written (${VAR} references are not expanded), type, default, allowed values, apply mode, " +
		"whether it is secret, whether config_set may change it, and its documentation. " +
		"Secrets (API keys, tokens, passwords) are never shown: they read " + Mask + " with whether they are set and where from. " +
		"Use it before config_set, and to answer questions about the current configuration."
}

func (t *GetTool) ParameterSchema() string {
	return `{"type":"object","properties":{"path":{"type":"string","description":"Dotted config path, such as llm or llm.model. Empty lists the top-level sections."}},"additionalProperties":false}`
}

func (t *GetTool) Execute(_ context.Context, params map[string]any) (string, error) {
	path, _ := params["path"].(string)
	out, err := Get(t.opts(), path)
	if err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

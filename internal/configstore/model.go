package configstore

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// The config as rows: every value outside the named collections is a settings row at its dotted
// path; LLM profiles, routes, MCP servers, Console endpoints and auth profiles are rows of their
// own tables. A collection item's field has a column only when it holds a value of the column's
// type that is not the column's default. Anything else about it (a value written out but equal to
// the default, a value of another type, a key the table has no column for) is a settings row at
// the item's path, so a document read back from the rows is the document that was saved, comments
// aside.

type colType int

const (
	colText colType = iota
	colBool
	colBoolNull
	colIntNull
	colRealNull
	colJSONList
	colJSONMap
)

type column struct {
	key  string // the YAML key
	name string // the column
	typ  colType
	def  int64 // colBool's default
}

var profileColumns = []column{
	{key: "description", name: "description", typ: colText},
	{key: "abilities", name: "abilities", typ: colJSONList},
	{key: "inference_provider", name: "inference_provider", typ: colText},
	{key: "provider", name: "provider", typ: colText},
	{key: "endpoint", name: "endpoint", typ: colText},
	{key: "api_key", name: "api_key", typ: colText},
	{key: "model", name: "model", typ: colText},
	{key: "supports_image_parts", name: "supports_image_parts", typ: colBoolNull},
	{key: "context_window_tokens", name: "context_window_tokens", typ: colIntNull},
	{key: "headers", name: "headers", typ: colJSONMap},
	{key: "cache_ttl", name: "cache_ttl", typ: colText},
	{key: "cache_key_prefix", name: "cache_key_prefix", typ: colText},
	{key: "request_timeout", name: "request_timeout", typ: colText},
	{key: "tools_emulation_mode", name: "tools_emulation_mode", typ: colText},
	{key: "temperature", name: "temperature", typ: colRealNull},
	{key: "reasoning_effort", name: "reasoning_effort", typ: colText},
	{key: "reasoning_budget_tokens", name: "reasoning_budget_tokens", typ: colIntNull},
}

// providerOptionKeys are the profile blocks kept together in provider_options.
var providerOptionKeys = []string{"azure", "bedrock", "cloudflare"}

var mcpColumns = []column{
	{key: "enable", name: "enabled", typ: colBool, def: 1},
	{key: "on_demand", name: "on_demand", typ: colBool, def: 0},
	{key: "description", name: "description", typ: colText},
	{key: "type", name: "type", typ: colText},
	{key: "command", name: "command", typ: colText},
	{key: "args", name: "args", typ: colJSONList},
	{key: "env", name: "env", typ: colJSONMap},
	{key: "url", name: "url", typ: colText},
	{key: "headers", name: "headers", typ: colJSONMap},
	{key: "allowed_tools", name: "allowed_tools", typ: colJSONList},
}

var endpointColumns = []column{
	{key: "url", name: "url", typ: colText},
	{key: "auth_token", name: "auth_token", typ: colText},
}

var routePurposes = []string{"main_loop", "decision", "addressing", "awareness", "heartbeat", "think", "plan_create", "image", "transcription"}

var mcpNameRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)

// DefaultProfileName is the llm_profiles row for the profile at llm.*.
const DefaultProfileName = "default"

type settingRow struct {
	Path  string
	Kind  string
	Value string
}

type itemRow struct {
	Name     string
	Position int
	Cols     map[string]any // column -> string | int64 | float64 | nil
}

type routeRow struct {
	Purpose    string
	Profile    string
	Fallbacks  string // JSON list
	Candidates []candidateRow
}

type candidateRow struct {
	Profile string
	Weight  int64
}

type authRow struct {
	Name     string
	Kind     string
	Secret   string
	Allow    string
	Bindings string
}

// Rows is the whole config as table rows.
type Rows struct {
	Settings  []settingRow
	Profiles  []itemRow
	Routes    []routeRow
	MCP       []itemRow
	Endpoints []itemRow
	Auth      []authRow
}

// fieldKinds is the settings registry's kind per path, when the registry is linked.
var fieldKinds = map[string]string{}

// SetFieldKinds gives the settings registry's kinds (configsettings registers them), so known
// values get their registry kind and maps the registry treats as one value are kept whole.
func SetFieldKinds(kinds map[string]string) {
	fieldKinds = kinds
}

type parser struct {
	rows Rows
}

func (p *parser) setting(path string, node *yaml.Node) error {
	value, err := toJSONValue(node)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	encoded, err := encodeJSON(value)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	kind := jsonKind(node)
	if registry, ok := fieldKinds[path]; ok && kindFits(registry, kind) {
		kind = registry
	}
	if kind == "string_map" {
		// Only the registry calls a map a string_map; other maps are json.
		if registry, ok := fieldKinds[path]; !ok || registry != "string_map" {
			kind = "json"
		}
	}
	p.rows.Settings = append(p.rows.Settings, settingRow{Path: path, Kind: kind, Value: encoded})
	return nil
}

// generic stores node at path: a leaf as one row, a mapping as a row per key below it. A mapping
// that is empty, has a key with a dot, or is one value in the registry is one row.
func (p *parser) generic(path string, node *yaml.Node) error {
	if node.Kind == yaml.AliasNode {
		node = node.Alias
	}
	if node.Kind != yaml.MappingNode || len(node.Content) == 0 {
		return p.setting(path, node)
	}
	if kind, ok := fieldKinds[path]; ok && (kind == "json" || kind == "string_map" || kind == "string_list") {
		return p.setting(path, node)
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if strings.ContainsAny(node.Content[i].Value, ".[]") || node.Content[i].Value == "" {
			return p.setting(path, node)
		}
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if err := p.generic(joinPath(path, node.Content[i].Value), node.Content[i+1]); err != nil {
			return err
		}
	}
	return nil
}

func joinPath(prefix, key string) string {
	if prefix == "" {
		return key
	}
	return prefix + "." + key
}

// columnValue converts node for c; ok is false when the column cannot hold it, or it is the
// column's default.
func columnValue(c column, node *yaml.Node) (any, bool, error) {
	if node.Kind == yaml.AliasNode {
		node = node.Alias
	}
	switch c.typ {
	case colText:
		if isScalarString(node) && node.Value != "" {
			if c.name == "type" && node.Value != "http" {
				return nil, false, nil
			}
			return node.Value, true, nil
		}
	case colBool, colBoolNull:
		if node.Kind == yaml.ScalarNode && node.ShortTag() == "!!bool" {
			var b bool
			if err := node.Decode(&b); err != nil {
				return nil, false, err
			}
			v := int64(0)
			if b {
				v = 1
			}
			if c.typ == colBool && v == c.def {
				return nil, false, nil
			}
			if node.Value != strconv.FormatBool(b) {
				return nil, false, nil
			}
			return v, true, nil
		}
	case colIntNull:
		if node.Kind == yaml.ScalarNode && node.ShortTag() == "!!int" {
			v, err := strconv.ParseInt(node.Value, 10, 64)
			if err == nil && strconv.FormatInt(v, 10) == node.Value {
				return v, true, nil
			}
		}
	case colRealNull:
		if node.Kind == yaml.ScalarNode && (node.ShortTag() == "!!float" || node.ShortTag() == "!!int") {
			v, err := strconv.ParseFloat(node.Value, 64)
			if err == nil && formatReal(v) == node.Value {
				return v, true, nil
			}
		}
	case colJSONList:
		if node.Kind == yaml.SequenceNode && len(node.Content) > 0 {
			value, err := toJSONValue(node)
			if err != nil {
				return nil, false, err
			}
			encoded, err := encodeJSON(value)
			return encoded, err == nil, err
		}
	case colJSONMap:
		if node.Kind == yaml.MappingNode && len(node.Content) > 0 {
			value, err := toJSONValue(node)
			if err != nil {
				return nil, false, err
			}
			encoded, err := encodeJSON(value)
			return encoded, err == nil, err
		}
	}
	return nil, false, nil
}

func formatReal(v float64) string {
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// item splits a mapping into columns and overflow rows under overflowPath.
func (p *parser) item(node *yaml.Node, cols []column, overflowPath func(key string) string, skip map[string]bool,
	special func(key string, value *yaml.Node) (bool, error)) (map[string]any, error) {
	values := map[string]any{}
	byKey := map[string]column{}
	for _, c := range cols {
		byKey[c.key] = c
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key, value := node.Content[i].Value, node.Content[i+1]
		if skip[key] {
			continue
		}
		if c, ok := byKey[key]; ok {
			v, fits, err := columnValue(c, value)
			if err != nil {
				return nil, err
			}
			if fits {
				values[c.name] = v
				continue
			}
		} else if special != nil {
			handled, err := special(key, value)
			if err != nil {
				return nil, err
			}
			if handled {
				continue
			}
		}
		if err := p.generic(overflowPath(key), value); err != nil {
			return nil, err
		}
	}
	return values, nil
}

func (p *parser) profile(name string, position int, node *yaml.Node, overflowPrefix string) error {
	options := orderedMap{}
	values, err := p.item(node, profileColumns, func(key string) string { return joinPath(overflowPrefix, key) }, nil,
		func(key string, value *yaml.Node) (bool, error) {
			for _, option := range providerOptionKeys {
				if key == option && value.Kind == yaml.MappingNode {
					v, err := toJSONValue(value)
					if err != nil {
						return false, err
					}
					options = append(options, orderedEntry{Key: key, Value: v})
					return true, nil
				}
			}
			return false, nil
		})
	if err != nil {
		return err
	}
	if len(options) > 0 {
		encoded, err := encodeJSON(options)
		if err != nil {
			return err
		}
		values["provider_options"] = encoded
	}
	p.rows.Profiles = append(p.rows.Profiles, itemRow{Name: name, Position: position, Cols: values})
	return nil
}

// parseDocument reads a config YAML document into rows.
func parseDocument(data []byte) (Rows, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return Rows{}, fmt.Errorf("parse config: %w", err)
	}
	p := &parser{}
	if doc.Kind == 0 || len(doc.Content) == 0 {
		return p.rows, nil
	}
	root := doc.Content[0]
	if root.Kind == yaml.ScalarNode && root.ShortTag() == "!!null" {
		return p.rows, nil
	}
	if root.Kind != yaml.MappingNode {
		return Rows{}, fmt.Errorf("config must be a mapping")
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		key, value := root.Content[i].Value, root.Content[i+1]
		if value.Kind == yaml.AliasNode {
			value = value.Alias
		}
		var err error
		switch {
		case key == "llm" && value.Kind == yaml.MappingNode:
			err = p.llm(value)
		case key == "mcp" && value.Kind == yaml.MappingNode:
			err = p.section(key, value, map[string]func(*yaml.Node) error{"servers": p.mcpServers})
		case key == "console" && value.Kind == yaml.MappingNode:
			err = p.section(key, value, map[string]func(*yaml.Node) error{"endpoints": p.endpoints})
		case key == "auth_profiles" && value.Kind == yaml.MappingNode && len(value.Content) > 0:
			err = p.authProfiles(value)
		case strings.ContainsAny(key, ".[]") || key == "":
			return Rows{}, fmt.Errorf("config key %q: dots and brackets are not supported in top-level keys", key)
		default:
			err = p.generic(key, value)
		}
		if err != nil {
			return Rows{}, err
		}
	}
	return p.rows, nil
}

// section stores a mapping's keys, handing the named ones to their collection.
func (p *parser) section(prefix string, node *yaml.Node, collections map[string]func(*yaml.Node) error) error {
	if len(node.Content) == 0 {
		return p.setting(prefix, node)
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key, value := node.Content[i].Value, node.Content[i+1]
		if fn, ok := collections[key]; ok {
			if err := fn(value); err != nil {
				return err
			}
			continue
		}
		if strings.ContainsAny(key, ".[]") || key == "" {
			return p.setting(prefix, node)
		}
		if err := p.generic(joinPath(prefix, key), value); err != nil {
			return err
		}
	}
	return nil
}

func (p *parser) llm(node *yaml.Node) error {
	if len(node.Content) == 0 {
		return p.setting("llm", node)
	}
	defaultProfile := &yaml.Node{Kind: yaml.MappingNode}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key, value := node.Content[i].Value, node.Content[i+1]
		switch {
		case key == "profiles":
			if err := p.profiles(value); err != nil {
				return err
			}
		case key == "routes":
			if err := p.routes(value); err != nil {
				return err
			}
		case isProfileKey(key):
			defaultProfile.Content = append(defaultProfile.Content, node.Content[i], value)
		case strings.ContainsAny(key, ".[]") || key == "":
			return fmt.Errorf("config key llm.%s: dots and brackets are not supported", key)
		default:
			if err := p.generic(joinPath("llm", key), value); err != nil {
				return err
			}
		}
	}
	if len(defaultProfile.Content) > 0 {
		return p.profile(DefaultProfileName, 0, defaultProfile, "llm")
	}
	return nil
}

func isProfileKey(key string) bool {
	for _, c := range profileColumns {
		if c.key == key {
			return true
		}
	}
	for _, option := range providerOptionKeys {
		if option == key {
			return true
		}
	}
	return false
}

func (p *parser) profiles(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode || len(node.Content) == 0 {
		return p.setting("llm.profiles", node)
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		name, value := node.Content[i].Value, node.Content[i+1]
		if value.Kind == yaml.AliasNode {
			value = value.Alias
		}
		if strings.ContainsAny(name, ".[]") || name == "" {
			return p.setting("llm.profiles", node)
		}
	}
	position := 1
	for i := 0; i+1 < len(node.Content); i += 2 {
		name, value := node.Content[i].Value, node.Content[i+1]
		if value.Kind == yaml.AliasNode {
			value = value.Alias
		}
		path := "llm.profiles." + name
		if name == DefaultProfileName || value.Kind != yaml.MappingNode {
			if err := p.setting(path, value); err != nil {
				return err
			}
			continue
		}
		if err := p.profile(name, position, value, path); err != nil {
			return err
		}
		position++
	}
	return nil
}

func isRoutePurpose(purpose string) bool {
	for _, known := range routePurposes {
		if known == purpose {
			return true
		}
	}
	return false
}

func (p *parser) routes(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode || len(node.Content) == 0 {
		return p.setting("llm.routes", node)
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		purpose, value := node.Content[i].Value, node.Content[i+1]
		if value.Kind == yaml.AliasNode {
			value = value.Alias
		}
		path := "llm.routes." + purpose
		if strings.ContainsAny(purpose, ".[]") || purpose == "" {
			return fmt.Errorf("config key %s: dots and brackets are not supported", path)
		}
		if !isRoutePurpose(purpose) {
			if err := p.setting(path, value); err != nil {
				return err
			}
			continue
		}
		if isScalarString(value) && value.Value != "" {
			p.rows.Routes = append(p.rows.Routes, routeRow{Purpose: purpose, Profile: value.Value, Fallbacks: "[]"})
			continue
		}
		if value.Kind != yaml.MappingNode || len(value.Content) == 0 {
			if err := p.setting(path, value); err != nil {
				return err
			}
			continue
		}
		route := routeRow{Purpose: purpose, Fallbacks: "[]"}
		for k := 0; k+1 < len(value.Content); k += 2 {
			key, field := value.Content[k].Value, value.Content[k+1]
			switch {
			case key == "profile" && isScalarString(field) && field.Value != "":
				route.Profile = field.Value
				continue
			case key == "fallback_profiles" && field.Kind == yaml.SequenceNode && len(field.Content) > 0 && jsonKind(field) == "string_list":
				v, err := toJSONValue(field)
				if err != nil {
					return err
				}
				if route.Fallbacks, err = encodeJSON(v); err != nil {
					return err
				}
				continue
			case key == "candidates" && field.Kind == yaml.SequenceNode && len(field.Content) > 0:
				if candidates, ok := parseCandidates(field); ok {
					route.Candidates = candidates
					continue
				}
			}
			if strings.ContainsAny(key, ".[]") || key == "" {
				return fmt.Errorf("config key %s.%s: dots and brackets are not supported", path, key)
			}
			if err := p.generic(joinPath(path, key), field); err != nil {
				return err
			}
		}
		p.rows.Routes = append(p.rows.Routes, route)
	}
	return nil
}

// parseCandidates reads candidates that are exactly {profile, weight} each; anything else is kept
// as written, as a settings row.
func parseCandidates(node *yaml.Node) ([]candidateRow, bool) {
	var out []candidateRow
	for _, item := range node.Content {
		if item.Kind != yaml.MappingNode {
			return nil, false
		}
		var c candidateRow
		hasProfile, hasWeight := false, false
		for k := 0; k+1 < len(item.Content); k += 2 {
			key, value := item.Content[k].Value, item.Content[k+1]
			switch key {
			case "profile":
				if !isScalarString(value) || value.Value == "" {
					return nil, false
				}
				c.Profile, hasProfile = value.Value, true
			case "weight":
				if value.Kind != yaml.ScalarNode || value.ShortTag() != "!!int" {
					return nil, false
				}
				w, err := strconv.ParseInt(value.Value, 10, 64)
				if err != nil || w < 0 || strconv.FormatInt(w, 10) != value.Value {
					return nil, false
				}
				c.Weight, hasWeight = w, true
			default:
				return nil, false
			}
		}
		if !hasProfile || !hasWeight {
			return nil, false
		}
		out = append(out, c)
	}
	return out, true
}

// listByName reports whether every item of a list is a mapping with a distinct valid name.
func listByName(node *yaml.Node, valid func(string) bool) bool {
	if node.Kind != yaml.SequenceNode || len(node.Content) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, item := range node.Content {
		if item.Kind != yaml.MappingNode {
			return false
		}
		name := ""
		for k := 0; k+1 < len(item.Content); k += 2 {
			if item.Content[k].Value == "name" && isScalarString(item.Content[k+1]) {
				name = item.Content[k+1].Value
			}
			if strings.ContainsAny(item.Content[k].Value, ".[]") || item.Content[k].Value == "" {
				return false
			}
		}
		if !valid(name) || seen[name] {
			return false
		}
		seen[name] = true
	}
	return true
}

func itemName(node *yaml.Node) string {
	for k := 0; k+1 < len(node.Content); k += 2 {
		if node.Content[k].Value == "name" {
			return node.Content[k+1].Value
		}
	}
	return ""
}

func (p *parser) mcpServers(node *yaml.Node) error {
	if !listByName(node, func(name string) bool { return mcpNameRE.MatchString(name) }) {
		return p.setting("mcp.servers", node)
	}
	for i, item := range node.Content {
		name := itemName(item)
		values, err := p.item(item, mcpColumns, func(key string) string { return "mcp.servers[" + name + "]." + key },
			map[string]bool{"name": true}, nil)
		if err != nil {
			return err
		}
		p.rows.MCP = append(p.rows.MCP, itemRow{Name: name, Position: i, Cols: values})
	}
	return nil
}

func (p *parser) endpoints(node *yaml.Node) error {
	if !listByName(node, func(name string) bool { return name != "" && !strings.ContainsAny(name, "[]") }) {
		return p.setting("console.endpoints", node)
	}
	for i, item := range node.Content {
		name := itemName(item)
		values, err := p.item(item, endpointColumns, func(key string) string { return "console.endpoints[" + name + "]." + key },
			map[string]bool{"name": true}, nil)
		if err != nil {
			return err
		}
		p.rows.Endpoints = append(p.rows.Endpoints, itemRow{Name: name, Position: i, Cols: values})
	}
	return nil
}

func (p *parser) authProfiles(node *yaml.Node) error {
	for i := 0; i+1 < len(node.Content); i += 2 {
		name := node.Content[i].Value
		if strings.ContainsAny(name, ".[]") || name == "" {
			return p.setting("auth_profiles", node)
		}
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		name, value := node.Content[i].Value, node.Content[i+1]
		if value.Kind == yaml.AliasNode {
			value = value.Alias
		}
		path := "auth_profiles." + name
		if value.Kind != yaml.MappingNode {
			if err := p.setting(path, value); err != nil {
				return err
			}
			continue
		}
		row := authRow{Name: name, Allow: "{}", Bindings: "{}"}
		for k := 0; k+1 < len(value.Content); k += 2 {
			key, field := value.Content[k].Value, value.Content[k+1]
			switch {
			case key == "credential" && field.Kind == yaml.MappingNode && len(field.Content) > 0:
				for c := 0; c+1 < len(field.Content); c += 2 {
					ckey, cvalue := field.Content[c].Value, field.Content[c+1]
					switch {
					case ckey == "kind" && isScalarString(cvalue) && cvalue.Value != "":
						row.Kind = cvalue.Value
					case ckey == "secret" && isScalarString(cvalue) && cvalue.Value != "":
						row.Secret = cvalue.Value
					default:
						if strings.ContainsAny(ckey, ".[]") || ckey == "" {
							return fmt.Errorf("config key %s.credential.%s: dots and brackets are not supported", path, ckey)
						}
						if err := p.generic(path+".credential."+ckey, cvalue); err != nil {
							return err
						}
					}
				}
				continue
			case (key == "allow" || key == "bindings") && field.Kind == yaml.MappingNode && len(field.Content) > 0:
				v, err := toJSONValue(field)
				if err != nil {
					return err
				}
				encoded, err := encodeJSON(v)
				if err != nil {
					return err
				}
				if key == "allow" {
					row.Allow = encoded
				} else {
					row.Bindings = encoded
				}
				continue
			}
			if strings.ContainsAny(key, ".[]") || key == "" {
				return fmt.Errorf("config key %s.%s: dots and brackets are not supported", path, key)
			}
			if err := p.generic(joinPath(path, key), field); err != nil {
				return err
			}
		}
		p.rows.Auth = append(p.rows.Auth, row)
	}
	return nil
}

// ---------- rendering ----------

// tree is a document being assembled from rows.
type tree struct {
	value *yaml.Node
	keys  []string
	kids  map[string]*tree
	list  []*tree // a sequence of mappings (the named lists)
	isSeq bool
}

func newTree() *tree { return &tree{kids: map[string]*tree{}} }

func (t *tree) child(key string) *tree {
	if t.kids == nil {
		t.kids = map[string]*tree{}
	}
	kid := t.kids[key]
	if kid == nil {
		kid = newTree()
		t.kids[key] = kid
		t.keys = append(t.keys, key)
	}
	return kid
}

func (t *tree) set(path []string, value *yaml.Node) {
	node := t
	for _, key := range path {
		node = node.child(key)
	}
	node.value = value
}

func columnNode(c column, raw any) (*yaml.Node, bool, error) {
	switch c.typ {
	case colText:
		s, _ := raw.(string)
		if s == "" || (c.name == "type" && s == "stdio") {
			return nil, false, nil
		}
		return stringNode(s), true, nil
	case colBool, colBoolNull:
		v, ok := raw.(int64)
		if !ok || (c.typ == colBool && v == c.def) {
			return nil, false, nil
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(v != 0)}, true, nil
	case colIntNull:
		v, ok := raw.(int64)
		if !ok {
			return nil, false, nil
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatInt(v, 10)}, true, nil
	case colRealNull:
		v, ok := raw.(float64)
		if !ok {
			return nil, false, nil
		}
		text := formatReal(v)
		tag := "!!float"
		if !strings.ContainsAny(text, ".eE") {
			tag = "!!int"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: text}, true, nil
	case colJSONList, colJSONMap:
		s, _ := raw.(string)
		if s == "" || s == "[]" || s == "{}" {
			return nil, false, nil
		}
		node, err := decodeJSONNode(s)
		return node, err == nil, err
	}
	return nil, false, nil
}

func setColumns(t *tree, cols []column, values map[string]any) error {
	for _, c := range cols {
		node, ok, err := columnNode(c, values[c.name])
		if err != nil {
			return err
		}
		if ok {
			t.child(c.key).value = node
		}
	}
	return nil
}

func (r Rows) render() ([]byte, error) {
	root := newTree()
	// Collections first, so the named lists exist when their overflow rows arrive.
	sort.SliceStable(r.Profiles, func(i, j int) bool { return r.Profiles[i].Position < r.Profiles[j].Position })
	for _, profile := range r.Profiles {
		var t *tree
		if profile.Name == DefaultProfileName {
			t = root.child("llm")
		} else {
			t = root.child("llm").child("profiles").child(profile.Name)
		}
		if err := setColumns(t, profileColumns, profile.Cols); err != nil {
			return nil, err
		}
		if raw, _ := profile.Cols["provider_options"].(string); raw != "" && raw != "{}" {
			node, err := decodeJSONNode(raw)
			if err != nil {
				return nil, err
			}
			for i := 0; i+1 < len(node.Content); i += 2 {
				t.child(node.Content[i].Value).value = node.Content[i+1]
			}
		}
		if t.value == nil && len(t.kids) == 0 {
			t.value = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		}
	}
	for _, route := range orderedRoutes(r.Routes) {
		t := root.child("llm").child("routes").child(route.Purpose)
		object := len(route.Candidates) > 0 || (route.Fallbacks != "" && route.Fallbacks != "[]") || route.Profile == "" ||
			hasSettingUnder(r.Settings, "llm.routes."+route.Purpose+".")
		if !object {
			// Overflow keys below make it an object again.
			t.value = stringNode(route.Profile)
			continue
		}
		if route.Profile != "" {
			t.child("profile").value = stringNode(route.Profile)
		}
		if len(route.Candidates) > 0 {
			seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			for _, c := range route.Candidates {
				seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{
					stringNode("profile"), stringNode(c.Profile),
					stringNode("weight"), {Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatInt(c.Weight, 10)},
				}})
			}
			t.child("candidates").value = seq
		}
		if route.Fallbacks != "" && route.Fallbacks != "[]" {
			node, err := decodeJSONNode(route.Fallbacks)
			if err != nil {
				return nil, err
			}
			t.child("fallback_profiles").value = node
		}
	}
	lists := map[string]map[string]*tree{}
	addList := func(path []string, key string, items []itemRow, cols []column) error {
		if len(items) == 0 {
			return nil
		}
		t := root
		for _, k := range path {
			t = t.child(k)
		}
		t.isSeq = true
		byName := map[string]*tree{}
		sort.SliceStable(items, func(i, j int) bool { return items[i].Position < items[j].Position })
		for _, item := range items {
			it := newTree()
			it.child("name").value = stringNode(item.Name)
			if err := setColumns(it, cols, item.Cols); err != nil {
				return err
			}
			t.list = append(t.list, it)
			byName[item.Name] = it
		}
		lists[key] = byName
		return nil
	}
	if err := addList([]string{"mcp", "servers"}, "mcp.servers", r.MCP, mcpColumns); err != nil {
		return nil, err
	}
	if err := addList([]string{"console", "endpoints"}, "console.endpoints", r.Endpoints, endpointColumns); err != nil {
		return nil, err
	}
	for _, auth := range r.Auth {
		t := root.child("auth_profiles").child(auth.Name)
		if auth.Kind != "" {
			t.child("credential").child("kind").value = stringNode(auth.Kind)
		}
		if auth.Secret != "" {
			t.child("credential").child("secret").value = stringNode(auth.Secret)
		}
		for key, raw := range map[string]string{"allow": auth.Allow, "bindings": auth.Bindings} {
			if raw != "" && raw != "{}" {
				node, err := decodeJSONNode(raw)
				if err != nil {
					return nil, err
				}
				t.child(key).value = node
			}
		}
		if t.value == nil && len(t.kids) == 0 {
			t.value = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		}
	}
	for _, s := range r.Settings {
		node, err := decodeJSONNode(s.Value)
		if err != nil {
			return nil, fmt.Errorf("setting %s: %w", s.Path, err)
		}
		if prefix, name, rest, ok := splitListPath(s.Path); ok {
			if item := lists[prefix][name]; item != nil {
				item.set(strings.Split(rest, "."), node)
				continue
			}
		}
		root.set(strings.Split(s.Path, "."), node)
	}
	doc := &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root.node("")}}
	if len(root.kids) == 0 {
		return []byte{}, nil
	}
	return marshalYAML(doc)
}

func orderedRoutes(routes []routeRow) []routeRow {
	out := append([]routeRow(nil), routes...)
	index := map[string]int{}
	for i, p := range routePurposes {
		index[p] = i
	}
	sort.SliceStable(out, func(i, j int) bool { return index[out[i].Purpose] < index[out[j].Purpose] })
	return out
}

// splitListPath splits "mcp.servers[name].key.sub" into its list, the item's name and the rest.
func splitListPath(path string) (string, string, string, bool) {
	for _, prefix := range []string{"mcp.servers", "console.endpoints"} {
		if !strings.HasPrefix(path, prefix+"[") {
			continue
		}
		rest := path[len(prefix)+1:]
		end := strings.Index(rest, "].")
		if end < 0 {
			return "", "", "", false
		}
		return prefix, rest[:end], rest[end+2:], true
	}
	return "", "", "", false
}

// node turns the tree at path into a YAML node, its keys in config.example.yaml's order.
func (t *tree) node(path string) *yaml.Node {
	if t.isSeq {
		seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		for _, item := range t.list {
			seq.Content = append(seq.Content, item.node(path+"[]"))
		}
		return seq
	}
	if len(t.kids) == 0 {
		if t.value == nil {
			return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		}
		return t.value
	}
	node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for _, key := range orderKeys(path, t.keys) {
		node.Content = append(node.Content, stringNode(key), t.kids[key].node(joinPath(path, key)))
	}
	return node
}

func marshalYAML(doc *yaml.Node) ([]byte, error) {
	var b strings.Builder
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return []byte(unescapeBigRunes(b.String())), nil
}

var bigRune = regexp.MustCompile(`\\U[0-9A-Fa-f]{8}`)

// unescapeBigRunes writes characters beyond the Basic Multilingual Plane (emoji) as they are,
// where yaml.v3 escapes them in double quotes.
func unescapeBigRunes(s string) string {
	return bigRune.ReplaceAllStringFunc(s, func(esc string) string {
		code, err := strconv.ParseUint(esc[2:], 16, 32)
		if err != nil {
			return esc
		}
		return string(rune(code))
	})
}

func hasSettingUnder(settings []settingRow, prefix string) bool {
	for _, s := range settings {
		if strings.HasPrefix(s.Path, prefix) {
			return true
		}
	}
	return false
}

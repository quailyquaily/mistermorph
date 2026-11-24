// Package configtools gives the agent its own config through two deferred tools: config_get reads
// values and structure, with every secret masked, and config_set changes one value after the
// user approves it. Both work on the config where `morph config` keeps it (agent.db, or the file
// --config names), as written: ${VAR} and secret references are never expanded.
package configtools

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/assets"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/configsettings"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// catalog is what is known about the config's keys: the field registry (kind, default, apply mode,
// whether it is secret) and the comments of the embedded config.example.yaml.
type catalog struct {
	fields map[string]configsettings.Field
	list   []configsettings.Field
	// example holds every documented path of config.example.yaml (keys and the mappings that
	// hold them), with its comment.
	example map[string]exampleEntry
	// exampleOrder is example's paths in document order.
	exampleOrder []string
	// topLevel is the top-level names in the order config_get lists them.
	topLevel []string
	defaults *viper.Viper
}

type exampleEntry struct {
	Comment string
	// Section: a mapping that holds documented keys, rather than a key of its own.
	Section bool
}

var (
	catalogOnce   sync.Once
	sharedCatalog *catalog
)

// Fields is the field registry config_set validates against: every agent, console and system
// field.
func Fields() []configsettings.Field {
	var out []configsettings.Field
	out = append(out, configsettings.AgentFields()...)
	out = append(out, configsettings.ConsoleFields()...)
	out = append(out, configsettings.SystemFields()...)
	return out
}

func loadCatalog() *catalog {
	catalogOnce.Do(func() {
		sharedCatalog = buildCatalog(Fields(), exampleYAML())
	})
	return sharedCatalog
}

func exampleYAML() []byte {
	data, err := assets.ConfigFS.ReadFile("config/config.example.yaml")
	if err != nil {
		return nil
	}
	return data
}

func buildCatalog(fields []configsettings.Field, example []byte) *catalog {
	c := &catalog{
		fields:  make(map[string]configsettings.Field, len(fields)),
		list:    fields,
		example: map[string]exampleEntry{},
	}
	for _, field := range fields {
		c.fields[strings.ToLower(field.Path)] = field
	}
	c.defaults = viper.New()
	configdefaults.Apply(c.defaults)

	var doc yaml.Node
	if len(example) > 0 && yaml.Unmarshal(example, &doc) == nil && len(doc.Content) > 0 {
		c.walkExample(doc.Content[0], "")
	}

	seen := map[string]bool{}
	add := func(name string) {
		if name != "" && !seen[name] {
			seen[name] = true
			c.topLevel = append(c.topLevel, name)
		}
	}
	for _, path := range c.exampleOrder {
		add(firstSegment(path))
	}
	for _, field := range fields {
		add(firstSegment(strings.ToLower(field.Path)))
	}
	return c
}

func (c *catalog) walkExample(node *yaml.Node, prefix string) {
	if node == nil || node.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		keyNode, value := node.Content[i], node.Content[i+1]
		key := strings.ToLower(strings.TrimSpace(keyNode.Value))
		if key == "" {
			continue
		}
		path := key
		if prefix != "" {
			path = prefix + "." + key
		}
		comment := joinComment(cleanComment(keyNode.HeadComment), cleanComment(keyNode.LineComment), cleanComment(value.LineComment))
		_, isField := c.fields[path]
		section := !isField && value.Kind == yaml.MappingNode && len(value.Content) > 0
		if _, dup := c.example[path]; !dup {
			c.exampleOrder = append(c.exampleOrder, path)
		}
		c.example[path] = exampleEntry{Comment: comment, Section: section}
		if section {
			c.walkExample(value, path)
		}
	}
}

// commentedKey matches a commented-out YAML key in a comment ("# temperature: 0.2", "# headers:"),
// which the comment's later lines no longer describe.
var commentedKey = regexp.MustCompile(`^#( *)[a-z][a-z0-9_]*:( |$)`)

// cleanComment turns a YAML comment into plain text. A head comment also holds the commented-out
// keys written before the key it belongs to: only the lines after the last of them (and after the
// lines that belong to it) describe the key.
func cleanComment(raw string) string {
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	start := 0
	for i, line := range lines {
		line = strings.TrimSpace(line)
		match := commentedKey.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		indent := len(match[1])
		j := i + 1
		for ; j < len(lines); j++ {
			next := strings.TrimSpace(lines[j])
			body := strings.TrimPrefix(next, "#")
			if next == "#" || len(body)-len(strings.TrimLeft(body, " ")) <= indent {
				break
			}
		}
		start = j
	}
	var out []string
	for _, line := range lines[start:] {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "#") {
			continue
		}
		text := strings.TrimPrefix(line, "#")
		if strings.HasPrefix(text, " ") {
			text = text[1:]
		}
		out = append(out, strings.TrimRight(text, " "))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func joinComment(parts ...string) string {
	var kept []string
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "\n")
}

func firstSegment(path string) string {
	head, _, _ := strings.Cut(path, ".")
	return head
}

// field returns the registry field at path.
func (c *catalog) field(path string) (configsettings.Field, bool) {
	field, ok := c.fields[path]
	return field, ok
}

// isKey reports whether path is a key config_get lists on its own: a registry field, or a
// documented example key (not a section).
func (c *catalog) isKey(path string) bool {
	if _, ok := c.fields[path]; ok {
		return true
	}
	entry, ok := c.example[path]
	return ok && !entry.Section
}

// isSection reports whether path holds known keys.
func (c *catalog) isSection(path string) bool {
	if path == "" {
		return true
	}
	if c.isKey(path) {
		return false
	}
	prefix := path + "."
	for key := range c.fields {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	for key := range c.example {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

// keysUnder lists the known keys under section, example order first, then the registry's.
func (c *catalog) keysUnder(section string) []string {
	prefix := ""
	if section != "" {
		prefix = section + "."
	}
	seen := map[string]bool{}
	var out []string
	for _, path := range c.exampleOrder {
		if strings.HasPrefix(path, prefix) && c.isKey(path) && !seen[path] {
			seen[path] = true
			out = append(out, path)
		}
	}
	var rest []string
	for path := range c.fields {
		if strings.HasPrefix(path, prefix) && !seen[path] {
			seen[path] = true
			rest = append(rest, path)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// hasKeyUnder reports whether a known key lies under path.
func (c *catalog) hasKeyUnder(path string) bool {
	prefix := path + "."
	for key := range c.fields {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	for key, entry := range c.example {
		if !entry.Section && strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func (c *catalog) comment(path string) string {
	return c.example[path].Comment
}

// defaultValue is the value a key has when the config does not set it.
func (c *catalog) defaultValue(path string) (any, bool) {
	if field, ok := c.fields[path]; ok && field.Default != nil {
		return field.Default, true
	}
	if !c.defaults.IsSet(path) {
		return nil, false
	}
	value := c.defaults.Get(path)
	if _, isMap := value.(map[string]any); isMap {
		return nil, false
	}
	return plainValue(value), true
}

func plainValue(value any) any {
	switch v := value.(type) {
	case time.Duration:
		return v.String()
	case []string:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = item
		}
		return out
	}
	return value
}

// sectionDescriptions are config_get's one-line descriptions of the top-level names.
var sectionDescriptions = map[string]string{
	"user_agent":         "User-Agent of outbound HTTP requests, including LLM calls.",
	"auto_update":        "Whether and from which release channel updates are installed.",
	"llm":                "The language model: provider, model, credentials, profiles and routes.",
	"logging":            "Log level, format, files and what logs include.",
	"secrets":            "Which auth profiles tools may use, and the AWS Secrets Manager source.",
	"auth_profiles":      "Credentials that tools such as url_fetch inject into requests.",
	"guard":              "Safety layer: network allowlists, redaction, approvals and audit.",
	"tools":              "Built-in tools: which are on, and their limits.",
	"mcp":                "MCP (Model Context Protocol) tool servers.",
	"bus":                "The in-process message bus.",
	"admins":             "Platform identities allowed to start Agent pairing.",
	"contacts":           "Contacts storage, proactive sends and Agent Link.",
	"memories":           "Memories the agent saves on purpose.",
	"stats":              "Usage statistics retention.",
	"tasks":              "Task projections and the task journal.",
	"skills":             "Skills: folder, loading and the skill store.",
	"server":             "Shared runtime API server settings.",
	"console":            "The web Console: listen address, login and managed runtimes.",
	"telegram":           "Telegram bot channel.",
	"slack":              "Slack bot channel.",
	"line":               "LINE bot channel.",
	"lark":               "Lark (Feishu) bot channel.",
	"mixin":              "Mixin bot channel.",
	"discord":            "Discord bot channel.",
	"wechat":             "WeChat channel.",
	"whatsapp":           "WhatsApp channel.",
	"bluesky":            "Bluesky account channel (DMs and mentions).",
	"x":                  "X account channel (DMs and mentions).",
	"heartbeat":          "Periodic heartbeat runs.",
	"cron":               "Scheduled jobs (the TODO list).",
	"max_steps":          "Most steps one task may take.",
	"parse_retries":      "How often an unparsable model reply is retried.",
	"max_token_budget":   "Token budget of one task (0: none).",
	"tool_repeat_limit":  "Most successful calls of one tool in a task.",
	"context_compaction": "When the conversation is compacted to fit the model's context window.",
	"timeout":            "Longest time one task may run.",
	"workspace_dir":      "Default workspace folder of file tools and commands.",
	"file_state_dir":     "The state folder (agent.db and other state).",
	"file_cache_dir":     "The cache folder (downloads, generated files).",
	"file_cache":         "Limits of the cache folder.",
}

func (c *catalog) sectionDescription(name string) string {
	if text, ok := sectionDescriptions[name]; ok {
		return text
	}
	comment := c.comment(name)
	first, _, _ := strings.Cut(comment, "\n")
	if strings.TrimSpace(first) != "" {
		return strings.TrimSpace(first)
	}
	return fmt.Sprintf("Settings under %s.", name)
}

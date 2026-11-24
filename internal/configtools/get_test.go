package configtools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type getOutput struct {
	Config      string        `json:"config"`
	Sections    []SectionInfo `json:"sections"`
	Section     string        `json:"section"`
	Description string        `json:"description"`
	Keys        []KeyInfo     `json:"keys"`
	Key         *KeyInfo      `json:"key"`
}

func runGet(t *testing.T, configPath, path string) (getOutput, string) {
	t.Helper()
	tool := NewGetTool(Options{ConfigPath: configPath})
	text, err := tool.Execute(context.Background(), map[string]any{"path": path})
	if err != nil {
		t.Fatalf("config_get(%q) error = %v", path, err)
	}
	var out getOutput
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("config_get(%q) output is not JSON: %v\n%s", path, err, text)
	}
	return out, text
}

func findKey(keys []KeyInfo, path string) (KeyInfo, bool) {
	for _, key := range keys {
		if key.Path == path {
			return key, true
		}
	}
	return KeyInfo{}, false
}

func TestGetOverviewListsSectionsWithDescriptions(t *testing.T) {
	// First run: no config yet.
	out, _ := runGet(t, dbConfig(t, ""), "")
	if out.Config != "agent_db" {
		t.Fatalf("config = %q, want agent_db", out.Config)
	}
	want := map[string]string{"llm": "section", "tools": "section", "telegram": "section", "max_steps": "key", "guard": "section"}
	got := map[string]SectionInfo{}
	for _, section := range out.Sections {
		got[section.Name] = section
		if strings.TrimSpace(section.Description) == "" {
			t.Errorf("section %q has no description", section.Name)
		}
		if section.Set {
			t.Errorf("section %q is set in an empty config", section.Name)
		}
	}
	for name, kind := range want {
		if got[name].Kind != kind {
			t.Errorf("section %q kind = %q, want %q", name, got[name].Kind, kind)
		}
	}
}

func TestGetSectionListsKeysWithValuesDefaultsAndComments(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt-test\n  reasoning_effort: low\n")
	out, _ := runGet(t, path, "llm")
	if out.Section != "llm" || out.Description == "" {
		t.Fatalf("section = %q, description = %q", out.Section, out.Description)
	}
	model, ok := findKey(out.Keys, "llm.model")
	if !ok {
		t.Fatalf("llm.model not listed: %+v", out.Keys)
	}
	if !model.Set || model.Value != "gpt-test" || model.Type != "string" || model.ApplyMode != "next_generation" || !model.Settable || model.Sensitive {
		t.Fatalf("llm.model = %+v", model)
	}
	if !strings.Contains(model.Comment, "Default model used by the main agent loop") {
		t.Fatalf("llm.model comment = %q, want the example's", model.Comment)
	}
	effort, _ := findKey(out.Keys, "llm.reasoning_effort")
	if len(effort.AllowedValues) == 0 || !strings.Contains(effort.Comment, "reasoning effort") || strings.Contains(effort.Comment, "temperature: 0.2") {
		t.Fatalf("llm.reasoning_effort = %+v: want allowed values and only its own comment", effort)
	}
	timeout, _ := findKey(out.Keys, "llm.request_timeout")
	if timeout.Set || timeout.Value != nil {
		t.Fatalf("llm.request_timeout = %+v, want unset", timeout)
	}
	apiKey, _ := findKey(out.Keys, "llm.api_key")
	if !apiKey.Sensitive || !apiKey.Settable || apiKey.Secret == nil || apiKey.Secret.Set {
		t.Fatalf("llm.api_key = %+v", apiKey)
	}
	endpoint, _ := findKey(out.Keys, "llm.endpoint")
	if endpoint.Settable || endpoint.NotSettableReason == "" {
		t.Fatalf("llm.endpoint = %+v, want not settable with a reason", endpoint)
	}

	// A key of the example that the field registry does not have is still listed, with its comment.
	skills, _ := runGet(t, path, "skills")
	indexURL, ok := findKey(skills.Keys, "skills.store.index_url")
	if !ok || !strings.Contains(indexURL.Comment, "Skill Store index") || indexURL.Settable {
		t.Fatalf("skills.store.index_url = %+v (listed %v)", indexURL, ok)
	}
}

func TestGetKeyAndNestedSection(t *testing.T) {
	path := dbConfig(t, "tools:\n  bash:\n    timeout: 45s\n")
	out, _ := runGet(t, path, "tools.bash.timeout")
	if out.Key == nil || out.Key.Value != "45s" || out.Key.Type != "duration" || out.Key.Default != "1m0s" {
		t.Fatalf("tools.bash.timeout = %+v", out.Key)
	}
	maxSteps, _ := runGet(t, path, "max_steps")
	if maxSteps.Key == nil || maxSteps.Key.Set || maxSteps.Key.Default == nil || maxSteps.Key.Min == nil {
		t.Fatalf("max_steps = %+v, want unset with a default and a minimum", maxSteps.Key)
	}
	bash, _ := runGet(t, path, "tools.bash")
	if _, ok := findKey(bash.Keys, "tools.bash.timeout"); !ok || bash.Section != "tools.bash" {
		t.Fatalf("tools.bash = %+v", bash)
	}
	if _, err := Get(Options{ConfigPath: path}, "no_such.key"); err == nil {
		t.Fatal("config_get(no_such.key) succeeded")
	}
	if _, err := Get(Options{ConfigPath: path}, "llm..model"); err == nil {
		t.Fatal("config_get(llm..model) succeeded")
	}
}

func TestGetListsWhatTheConfigSetsOutsideTheCatalog(t *testing.T) {
	path := fileConfig(t, `llm:
  profiles:
    cheap:
      model: gpt-mini
      api_key: sk-profile-secret-0001
custom_section:
  answer: 42
`)
	out, text := runGet(t, path, "llm")
	if out.Config != "file" {
		t.Fatalf("config = %q", out.Config)
	}
	mustNotContain(t, "config_get(llm)", text, "sk-profile-secret-0001")
	profiles, ok := findKey(out.Keys, "llm.profiles")
	if !ok || profiles.Settable || profiles.Type != "mapping" {
		t.Fatalf("llm.profiles = %+v (listed %v)", profiles, ok)
	}
	cheap := profiles.Value.(map[string]any)["cheap"].(map[string]any)
	if cheap["model"] != "gpt-mini" || !strings.HasPrefix(cheap["api_key"].(string), Mask) {
		t.Fatalf("llm.profiles.cheap = %#v", cheap)
	}
	overview, _ := runGet(t, path, "")
	found := false
	for _, section := range overview.Sections {
		if section.Name == "custom_section" && section.Set {
			found = true
		}
	}
	if !found {
		t.Fatalf("overview misses custom_section: %+v", overview.Sections)
	}
	key, _ := runGet(t, path, "llm.profiles.cheap.api_key")
	if key.Key == nil || key.Key.Value != Mask || key.Key.Secret == nil || key.Key.Secret.Source != SourceLiteral {
		t.Fatalf("llm.profiles.cheap.api_key = %+v", key.Key)
	}
}

// The switches of the tools themselves are documented in the example.
func TestGetDocumentsTheToolSwitches(t *testing.T) {
	path := dbConfig(t, "")
	for key, want := range map[string]string{"tools.config_get.enabled": "never shown", "tools.config_set.enabled": "approve"} {
		out, _ := runGet(t, path, key)
		if out.Key == nil || out.Key.Default != true || out.Key.Type != "bool" || !strings.Contains(out.Key.Comment, want) {
			t.Fatalf("%s = %+v", key, out.Key)
		}
	}
}

func TestCleanCommentDropsCommentedOutKeys(t *testing.T) {
	raw := "# Optional custom HTTP headers.\n# headers:\n#   YOUR-HEADER: \"x\"\n# Cache hint shared across providers.\n# Values:\n#   - off"
	got := cleanComment(raw)
	want := "Cache hint shared across providers.\nValues:\n  - off"
	if got != want {
		t.Fatalf("cleanComment() = %q, want %q", got, want)
	}
}

package configtools

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/tools"
)

func setTool(path string, store *memoryStore) *SetTool {
	opts := Options{ConfigPath: path}
	if store != nil {
		opts.SecretStore = store
	}
	return NewSetTool(opts)
}

func runSet(t *testing.T, tool *SetTool, ctx context.Context, params map[string]any) (map[string]any, error) {
	t.Helper()
	if _, err := tool.ApprovalPreview(ctx, params); err != nil {
		return nil, err
	}
	text, err := tool.Execute(ctx, params)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("config_set output is not JSON: %v\n%s", err, text)
	}
	return out, nil
}

// updatedBy is who last saved the agent.db row that holds setting: its settings row, or for the
// default LLM profile's keys (llm.model, llm.api_key, ...) the default profile's row.
func updatedBy(t *testing.T, configPath, setting string) string {
	t.Helper()
	db, err := agentdb.CachedBeside(configPath).GetWithoutImports(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	query, arg := `SELECT updated_by FROM settings WHERE path = ?`, setting
	if strings.HasPrefix(setting, "llm.") && !strings.HasPrefix(setting, "llm.routes.") {
		query, arg = `SELECT updated_by FROM llm_profiles WHERE name = ?`, configstore.DefaultProfileName
	}
	var by string
	if err := db.QueryRowContext(context.Background(), query, arg).Scan(&by); err != nil {
		t.Fatalf("row of %s: %v", setting, err)
	}
	return by
}

func TestSetChangesAKeyAsTheAgent(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt-old\n")
	tool := setTool(path, nil)
	preview, err := tool.ApprovalPreview(ownerCtx(), map[string]any{"path": "llm.model", "value": "gpt-new"})
	if err != nil {
		t.Fatalf("ApprovalPreview() error = %v", err)
	}
	if !strings.Contains(preview.Summary, "llm.model") || !strings.Contains(preview.Summary, "gpt-old") || !strings.Contains(preview.Summary, "gpt-new") ||
		preview.Params["current_value"] != "gpt-old" || preview.Params["new_value"] != "gpt-new" || preview.Params["apply_mode"] != "next_generation" {
		t.Fatalf("preview = %+v", preview)
	}
	if !strings.Contains(readConfig(t, path), "gpt-old") {
		t.Fatal("the preview changed the config")
	}
	out, err := runSet(t, tool, ownerCtx(), map[string]any{"path": "llm.model", "value": "gpt-new"})
	if err != nil {
		t.Fatalf("config_set error = %v", err)
	}
	if out["saved"] != true || out["value"] != "gpt-new" || out["previous_value"] != "gpt-old" || out["apply_mode"] != "next_generation" || out["apply_note"] == "" {
		t.Fatalf("config_set = %+v", out)
	}
	if !strings.Contains(readConfig(t, path), "model: gpt-new") {
		t.Fatalf("config = %s", readConfig(t, path))
	}
	if by := updatedBy(t, path, "llm.model"); by != configstore.ByAgent {
		t.Fatalf("updated_by = %q, want %q", by, configstore.ByAgent)
	}
	if _, err := runSet(t, tool, ownerCtx(), map[string]any{"path": "telegram.task_timeout", "value": "5m"}); err != nil {
		t.Fatalf("config_set(telegram.task_timeout) error = %v", err)
	}
	if by := updatedBy(t, path, "telegram.task_timeout"); by != configstore.ByAgent {
		t.Fatalf("telegram.task_timeout updated_by = %q, want %q", by, configstore.ByAgent)
	}
}

func TestSetReadsValuesAsYAMLAndValidatesThemAgainstTheRegistry(t *testing.T) {
	path := dbConfig(t, "")
	tool := setTool(path, nil)
	for _, tc := range []struct {
		path, value string
		want        string
	}{
		{"tools.bash.timeout", "90s", "timeout: 90s"},
		{"max_steps", "12", "max_steps: 12"},
		{"tools.write_file.enabled", "false", "enabled: false"},
		{"llm.abilities", "[text, image]", "- image"},
		{"llm.cache_key_prefix", "2024", "cache_key_prefix: \"2024\""},
		{"heartbeat.interval", "45m", "interval: 45m"},
		{"auto_update.enabled", "true", "enabled: true"},
	} {
		out, err := runSet(t, tool, ownerCtx(), map[string]any{"path": tc.path, "value": tc.value})
		if err != nil {
			t.Fatalf("config_set(%s=%s) error = %v", tc.path, tc.value, err)
		}
		if !strings.Contains(readConfig(t, path), tc.want) {
			t.Fatalf("config_set(%s=%s) config:\n%s\nwant %q", tc.path, tc.value, readConfig(t, path), tc.want)
		}
		field, _ := loadCatalog().field(tc.path)
		if out["apply_mode"] != string(field.ApplyMode) {
			t.Fatalf("config_set(%s) apply_mode = %v, want %s", tc.path, out["apply_mode"], field.ApplyMode)
		}
	}
	before := readConfig(t, path)
	for _, tc := range []struct{ path, value, want string }{
		{"llm.reasoning_effort", "extreme", "must be one of"},
		{"max_steps", "abc", "must be an integer"},
		{"max_steps", "0", "at least"},
		{"tools.bash.timeout", "soon", "duration"},
		{"llm.abilities", "[telepathy]", "must be one of"},
		{"context_compaction.trigger_ratio", "2", "at most"},
		{"llm.model", "[a, b]", "must be text"},
		{"llm.model", "{unclosed", "not valid YAML"},
	} {
		if _, err := runSet(t, tool, ownerCtx(), map[string]any{"path": tc.path, "value": tc.value}); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("config_set(%s=%s) error = %v, want %q", tc.path, tc.value, err, tc.want)
		}
	}
	if readConfig(t, path) != before {
		t.Fatal("a refused change changed the config")
	}
}

func TestSetUnsetsAKey(t *testing.T) {
	path := fileConfig(t, "tools:\n  bash:\n    timeout: 90s\n")
	out, err := runSet(t, setTool(path, nil), ownerCtx(), map[string]any{"path": "tools.bash.timeout", "unset": true})
	if err != nil {
		t.Fatalf("config_set(unset) error = %v", err)
	}
	if strings.Contains(readConfig(t, path), "timeout") || out["config"] != "file" {
		t.Fatalf("config = %q, out = %+v", readConfig(t, path), out)
	}
	if _, err := runSet(t, setTool(path, nil), ownerCtx(), map[string]any{"path": "max_steps", "unset": true, "value": "3"}); err == nil {
		t.Fatal("value and unset together succeeded")
	}
	if _, err := runSet(t, setTool(path, nil), ownerCtx(), map[string]any{"path": "max_steps"}); err == nil {
		t.Fatal("a call without value succeeded")
	}
}

// The deny list holds whatever the user would approve: the path, anything under it and anything
// that holds it.
func TestSetRefusesDeniedPathsBeforeAsking(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt\n")
	tool := setTool(path, newMemoryStore())
	for _, denied := range []string{
		"guard.enabled", "guard.approvals.enabled", "guard", "secrets.allow_profiles", "secrets",
		"console.password", "console.listen", "console", "server.auth_token", "llm.endpoint", "LLM.Endpoint",
		"llm", "llm.profiles.cheap.endpoint", "llm.profiles.cheap.api_key", "mcp.servers", "mcp",
		"file_state_dir", "workspace_dir", "slack.base_url", "bluesky.service_url", "x.owners", "bluesky.owners", "admins",
		"tools.bash.deny_paths", "tools.read_file.deny_paths", "tools.bash.injected_env_vars", "tools.bash.elevation.enabled",
		"tools.coder.bypass_approvals.codex", "tools", "tools.bash", "auth_profiles.jsonbill", "logging.redact_keys", "llm.headers",
	} {
		params := map[string]any{"path": denied, "value": "x"}
		if _, err := tool.ApprovalPreview(ownerCtx(), params); err == nil {
			t.Errorf("ApprovalPreview(%s) succeeded", denied)
		}
		if _, err := tool.Execute(ownerCtx(), params); err == nil {
			t.Errorf("Execute(%s) succeeded", denied)
		}
	}
	// Keys outside the registry cannot be written either.
	for _, unknown := range []string{"llm.routes", "no_such_key", "llm.description", "skills.store.index_url"} {
		if _, err := tool.ApprovalPreview(ownerCtx(), map[string]any{"path": unknown, "value": "x"}); err == nil {
			t.Errorf("ApprovalPreview(%s) succeeded", unknown)
		}
	}
	if readConfig(t, path) != "llm:\n  model: gpt\n" {
		t.Fatalf("config = %q", readConfig(t, path))
	}
}

func TestSetRefusesTheMaskAndReferences(t *testing.T) {
	t.Setenv("FT179_SOME_VAR", "x")
	path := dbConfig(t, "llm:\n  api_key: sk-original-key-material-0001\n")
	store := newMemoryStore()
	tool := setTool(path, store)
	got, _ := Get(Options{ConfigPath: path}, "llm.api_key")
	masked := got["key"].(KeyInfo).Value.(string)
	for _, tc := range []map[string]any{
		{"path": "llm.api_key", "value": masked},
		{"path": "llm.api_key", "value": Mask + " (literal)"},
		{"path": "llm.api_key", "value": "prefix" + Mask},
		{"path": "llm.api_key", "value": "${secret:AbCdEfGhIjKlMnOpQrStUvWx12}"},
		{"path": "llm.api_key", "value": "Bearer ${FT179_SOME_VAR}"},
		{"path": "llm.model", "value": "${FT179_SOME_VAR}"},
		{"path": "user_agent", "value": "morph ${OPENAI_API_KEY}"},
		{"path": "llm.headers", "value": "{X-Key: abc}"},
		{"path": "llm.image.options.openai", "value": "{api_key: abc}"},
		{"path": "llm.image.options.openai", "value": "{base_url: https://evil.invalid}"},
		{"path": "llm.routes.main_loop", "value": "{profile: default, endpoint: https://evil.invalid}"},
	} {
		if _, err := tool.ApprovalPreview(ownerCtx(), tc); err == nil {
			t.Errorf("ApprovalPreview(%v) succeeded", tc)
		}
	}
	if !strings.Contains(readConfig(t, path), "sk-original-key-material-0001") || len(store.values()) != 0 {
		t.Fatalf("a refused change wrote: config %q, store %v", readConfig(t, path), store.values())
	}
}

func TestSetStoresSecretsInTheKeyring(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt\n")
	store := newMemoryStore()
	tool := setTool(path, store)
	const secret = "sk-brand-new-secret-key-0042"
	params := map[string]any{"path": "llm.api_key", "value": secret}
	preview, err := tool.ApprovalPreview(ownerCtx(), params)
	if err != nil {
		t.Fatalf("ApprovalPreview() error = %v", err)
	}
	data, _ := json.Marshal(preview)
	mustNotContain(t, "preview", string(data), secret)
	text, err := tool.Execute(ownerCtx(), params)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	mustNotContain(t, "result", text, secret)
	config := readConfig(t, path)
	mustNotContain(t, "config", config, secret)
	if !strings.Contains(config, "${secret:") {
		t.Fatalf("config = %q, want a keyring reference", config)
	}
	if values := store.values(); len(values) != 1 || values[0] != secret {
		t.Fatalf("keyring = %v", values)
	}
	if by := updatedBy(t, path, "llm.api_key"); by != configstore.ByAgent {
		t.Fatalf("updated_by = %q", by)
	}

	// Replacing it stores the new key and drops the old entry.
	if _, err := runSet(t, tool, ownerCtx(), map[string]any{"path": "llm.api_key", "value": "sk-second-secret-key-0043"}); err != nil {
		t.Fatalf("second config_set error = %v", err)
	}
	if values := store.values(); len(values) != 1 || values[0] != "sk-second-secret-key-0043" {
		t.Fatalf("keyring after replace = %v", values)
	}
	// An environment reference needs no keyring and is kept as written.
	if _, err := runSet(t, setTool(path, nil), ownerCtx(), map[string]any{"path": "llm.api_key", "value": "${OPENAI_API_KEY}"}); err != nil {
		t.Fatalf("config_set(${OPENAI_API_KEY}) error = %v", err)
	}
	if !strings.Contains(readConfig(t, path), "${OPENAI_API_KEY}") {
		t.Fatalf("config = %q", readConfig(t, path))
	}
}

func TestSetRefusesAPlainSecretWithoutAKeyring(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt\n")
	const secret = "sk-no-keyring-secret-0099"
	_, err := runSet(t, setTool(path, nil), ownerCtx(), map[string]any{"path": "telegram.bot_token", "value": secret})
	if err == nil || !strings.Contains(err.Error(), "keyring") {
		t.Fatalf("config_set without a keyring error = %v", err)
	}
	mustNotContain(t, "error", err.Error(), secret)

	failing := newMemoryStore()
	failing.fail = true
	_, err = runSet(t, setTool(path, failing), ownerCtx(), map[string]any{"path": "telegram.bot_token", "value": secret})
	if err == nil || !strings.Contains(err.Error(), "nothing was changed") {
		t.Fatalf("config_set with a failing keyring error = %v", err)
	}
	mustNotContain(t, "error", err.Error(), secret)
	mustNotContain(t, "config", readConfig(t, path), secret, "bot_token")
}

func TestSetIsOnlyForTheOwnerInAPrivateApprovedCall(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt\n")
	tool := setTool(path, nil)
	params := map[string]any{"path": "llm.model", "value": "other"}
	group := audience.Conversation("tg:-100123")
	group.Speaker, group.SpeakerIsOwner = "tg:1", true
	for name, ctx := range map[string]context.Context{
		"no audience":         tools.WithUserApproval(context.Background()),
		"contact":             tools.WithUserApproval(audience.NewContext(context.Background(), audience.Contact("tg:42"))),
		"group with an owner": tools.WithUserApproval(audience.NewContext(context.Background(), group)),
	} {
		if _, err := tool.ApprovalPreview(ctx, params); err == nil {
			t.Errorf("%s: ApprovalPreview() succeeded", name)
		}
		if _, err := tool.Execute(ctx, params); err == nil {
			t.Errorf("%s: Execute() succeeded", name)
		}
	}
	unapproved := audience.NewContext(context.Background(), audience.Owner())
	if _, err := tool.Execute(unapproved, params); err == nil || !strings.Contains(err.Error(), "approves") {
		t.Fatalf("Execute() without an approval error = %v", err)
	}
	if !strings.Contains(readConfig(t, path), "model: gpt\n") {
		t.Fatalf("config = %q", readConfig(t, path))
	}
}

func TestSetRefusesAKeyAnEnvironmentVariableSets(t *testing.T) {
	t.Setenv("MISTER_MORPH_LLM_MODEL", "from-env")
	path := dbConfig(t, "")
	if _, err := runSet(t, setTool(path, nil), ownerCtx(), map[string]any{"path": "llm.model", "value": "x"}); err == nil || !strings.Contains(err.Error(), "MISTER_MORPH_LLM_MODEL") {
		t.Fatalf("config_set error = %v", err)
	}
}

func TestSetChecksRoutes(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt\n  profiles:\n    cheap:\n      model: gpt-mini\n")
	tool := setTool(path, nil)
	if _, err := runSet(t, tool, ownerCtx(), map[string]any{"path": "llm.routes.main_loop", "value": "missing_profile"}); err == nil {
		t.Fatal("a route to a missing profile was accepted")
	}
	if _, err := runSet(t, tool, ownerCtx(), map[string]any{"path": "llm.routes.image", "value": "{profile: cheap, fallback_profiles: [default]}"}); err == nil {
		t.Fatal("an image route with fallbacks was accepted")
	}
	if _, err := runSet(t, tool, ownerCtx(), map[string]any{"path": "llm.routes.main_loop", "value": "{profile: cheap, fallback_profiles: [default]}"}); err != nil {
		t.Fatalf("a valid route was refused: %v", err)
	}
}

func TestSetAsksTheRuntimeToReload(t *testing.T) {
	path := dbConfig(t, "")
	calls := 0
	ctx := WithReloader(ownerCtx(), func(context.Context) error { calls++; return nil })
	out, err := runSet(t, setTool(path, nil), ctx, map[string]any{"path": "max_steps", "value": "20"})
	if err != nil || calls != 1 || out["reload"] != "requested" {
		t.Fatalf("out = %+v, err = %v, reloads = %d", out, err, calls)
	}
	ctx = WithReloader(ownerCtx(), func(context.Context) error { return errors.New("busy") })
	out, err = runSet(t, setTool(path, nil), ctx, map[string]any{"path": "max_steps", "value": "21"})
	if err != nil || !strings.HasPrefix(out["reload"].(string), "failed") || out["saved"] != true {
		t.Fatalf("out = %+v, err = %v", out, err)
	}
}

func TestToolsAreDeferred(t *testing.T) {
	get, set := NewGetTool(Options{}), NewSetTool(Options{})
	if !tools.IsDeferred(get) || !tools.IsDeferred(set) || !tools.IsCodeModeExcluded(set) {
		t.Fatal("config tools must be deferred, and config_set excluded from codemode")
	}
	var schema map[string]any
	for _, tool := range []tools.Tool{get, set} {
		if err := json.Unmarshal([]byte(tool.ParameterSchema()), &schema); err != nil {
			t.Fatalf("%s schema: %v", tool.Name(), err)
		}
	}
}

// The name the Console's human is addressed by is theirs to set: the agent cannot change it.
func TestSetRefusesTheConsoleUserName(t *testing.T) {
	path := dbConfig(t, "console:\n  user_name: Lyra\n")
	before := readConfig(t, path)
	_, err := runSet(t, setTool(path, nil), ownerCtx(), map[string]any{"path": "console.user_name", "value": "Morph"})
	if err == nil || !strings.Contains(err.Error(), "cannot be changed by the agent") {
		t.Fatalf("config_set(console.user_name) error = %v, want a refusal", err)
	}
	if readConfig(t, path) != before {
		t.Fatal("a refused change changed the config")
	}
}

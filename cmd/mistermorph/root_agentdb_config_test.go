package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/cmd/mistermorph/configcmd"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

const precedenceConfig = `
llm:
  inference_provider: openai
  model: "from-config"
  api_key: "${FT36_TEST_KEY}"
  request_timeout: "90s"
  profiles:
    cheap:
      model: cheap-model
      api_key: "${FT36_TEST_KEY}"
  routes:
    main_loop:
      candidates:
        - profile: default
          weight: 1
        - profile: cheap
          weight: 2
    decision: cheap
telegram:
  allowed_chat_ids: ["tg:@admin"]
heartbeat:
  interval: "45m"
mcp:
  servers:
    - name: fs
      command: npx
console:
  endpoints:
    - name: Remote
      url: "http://127.0.0.1:8787/runtime"
auth_profiles:
  bill:
    credential:
      kind: api_key
      secret: "${FT36_TEST_KEY}"
future_section:
  knob: 3
`

// leafPaths lists the dotted paths of a YAML document's values.
func leafPaths(t *testing.T, data string) []string {
	t.Helper()
	var root map[string]any
	if err := yaml.Unmarshal([]byte(data), &root); err != nil {
		t.Fatal(err)
	}
	var out []string
	var walk func(prefix string, v any)
	walk = func(prefix string, v any) {
		if m, ok := v.(map[string]any); ok && len(m) > 0 {
			for k, child := range m {
				walk(strings.TrimPrefix(prefix+"."+k, "."), child)
			}
			return
		}
		out = append(out, prefix)
	}
	walk("", root)
	sort.Strings(out)
	return out
}

func loadedValues(t *testing.T, paths []string) map[string]any {
	t.Helper()
	out := map[string]any{}
	for _, path := range paths {
		out[path] = viper.Get(path)
	}
	return out
}

func TestRootConfigFromAgentDBMatchesTheFile(t *testing.T) {
	resetRootConfigForTest(t)
	t.Setenv("FT36_TEST_KEY", "sk-expanded")
	paths := leafPaths(t, precedenceConfig)

	// The file, named with --config.
	file := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(file, []byte(precedenceConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	viper.Set("config", file)
	if err := loadRootConfig(nil); err != nil {
		t.Fatal(err)
	}
	fromFile := loadedValues(t, paths)
	if fromFile["llm.api_key"] != "sk-expanded" {
		t.Fatalf("file api_key = %v", fromFile["llm.api_key"])
	}

	// The same config at the default path, imported into agent.db.
	viper.Reset()
	home := os.Getenv("HOME")
	morph := filepath.Join(home, ".morph")
	if err := os.MkdirAll(morph, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(morph, "config.yaml"), []byte(precedenceConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := loadRootConfig(nil); err != nil {
		t.Fatal(err)
	}
	if got := viper.GetString("config"); got != configstore.DBConfigPath(morph) {
		t.Fatalf("config = %q, want agent.db", got)
	}
	fromDB := loadedValues(t, paths)
	// A route written as {profile: x} and one written as x read the same; both are as written here.
	if !reflect.DeepEqual(fromDB, fromFile) {
		t.Fatalf("agent.db config differs from the file:\n db   %v\n file %v", fromDB, fromFile)
	}
	if _, err := os.Stat(filepath.Join(morph, "config.yaml.imported")); err != nil {
		t.Fatalf("default config not renamed: %v", err)
	}
	// Secrets stay as written in agent.db.
	raw, err := configstore.ReadFile(configstore.DBConfigPath(morph))
	if err != nil || !strings.Contains(string(raw), "${FT36_TEST_KEY}") || strings.Contains(string(raw), "sk-expanded") {
		t.Fatalf("stored config = %s, %v", raw, err)
	}

	// Environment variables still win over the config, and a second start reads agent.db.
	viper.Reset()
	t.Setenv("MISTER_MORPH_LLM_MODEL", "from-env")
	if err := loadRootConfig(nil); err != nil {
		t.Fatal(err)
	}
	if got := viper.GetString("llm.model"); got != "from-env" {
		t.Fatalf("llm.model = %q, want the environment's", got)
	}
	if got := viper.GetString("heartbeat.interval"); got != "45m" {
		t.Fatalf("heartbeat.interval = %q", got)
	}
}

func TestRootConfigFlagOverridesAgentDB(t *testing.T) {
	resetRootConfigForTest(t)
	state := t.TempDir()
	t.Setenv("MISTER_MORPH_FILE_STATE_DIR", state)
	if err := configstore.WriteFileBy(configstore.DBConfigPath(state), []byte("llm:\n  provider: openai\n  model: m\n  api_key: from-db\n"), configstore.ByCLI); err != nil {
		t.Fatal(err)
	}
	cmd := rootCommandForTest(t)
	run, _, err := cmd.Find([]string{"run"})
	if err != nil {
		t.Fatal(err)
	}
	if err := run.Flags().Set("api-key", "cli-api-key"); err != nil {
		t.Fatal(err)
	}
	if err := loadRootConfig(run); err != nil {
		t.Fatal(err)
	}
	if got := viper.GetString("llm.api_key"); got != "cli-api-key" {
		t.Fatalf("llm.api_key = %q, want the flag's", got)
	}
	if got := viper.GetString("file_state_dir"); got != state {
		t.Fatalf("file_state_dir = %q, want %q", got, state)
	}
}

func TestExplicitConfigNeverTouchesAgentDB(t *testing.T) {
	resetRootConfigForTest(t)
	state := t.TempDir()
	t.Setenv("MISTER_MORPH_FILE_STATE_DIR", state)
	home := os.Getenv("HOME")
	morph := filepath.Join(home, ".morph")
	if err := os.MkdirAll(morph, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(morph, "config.yaml"), []byte("llm:\n  model: default-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(file, []byte("llm:\n  model: explicit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	viper.Set("config", file)
	if err := loadRootConfig(nil); err != nil {
		t.Fatal(err)
	}
	if got := viper.GetString("llm.model"); got != "explicit" {
		t.Fatalf("llm.model = %q", got)
	}
	// Saving goes to the file.
	if err := configstore.WriteFile(viper.GetString("config"), []byte("llm:\n  model: saved\n")); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(file); string(raw) != "llm:\n  model: saved\n" {
		t.Fatalf("file = %q", raw)
	}
	if _, err := os.Stat(filepath.Join(state, "agent.db")); !os.IsNotExist(err) {
		t.Fatalf("agent.db created with --config: %v", err)
	}
	if _, err := os.Stat(filepath.Join(morph, "config.yaml")); err != nil {
		t.Fatalf("the default config was imported with --config: %v", err)
	}
}

func TestStateDirComesFromTheFlagTheEnvironmentOrTheOldConfig(t *testing.T) {
	resetRootConfigForTest(t)
	home := os.Getenv("HOME")
	morph := filepath.Join(home, ".morph")
	if err := os.MkdirAll(morph, 0o700); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(t.TempDir(), "old-state")
	if err := os.WriteFile(filepath.Join(morph, "config.yaml"), []byte("file_state_dir: "+old+"\nllm:\n  model: m\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := bootstrapStateDir(nil); got != old {
		t.Fatalf("from the old config = %q, want %q", got, old)
	}
	if err := loadRootConfig(nil); err != nil {
		t.Fatal(err)
	}
	if got := viper.GetString("file_state_dir"); got != old {
		t.Fatalf("file_state_dir after the import = %q", got)
	}
	// The imported copy still points there, and agent.db keeps no file_state_dir.
	if got := bootstrapStateDir(nil); got != old {
		t.Fatalf("after the import = %q", got)
	}
	raw, _ := configstore.ReadFile(configstore.DBConfigPath(old))
	if strings.Contains(string(raw), "file_state_dir") {
		t.Fatalf("agent.db config kept file_state_dir:\n%s", raw)
	}
	env := t.TempDir()
	t.Setenv("MISTER_MORPH_FILE_STATE_DIR", env)
	if got := bootstrapStateDir(nil); got != env {
		t.Fatalf("from the environment = %q", got)
	}
	cmd := rootCommandForTest(t)
	flagged := t.TempDir()
	if err := cmd.PersistentFlags().Set("state-dir", flagged); err != nil {
		t.Fatal(err)
	}
	if got := bootstrapStateDir(cmd); got != flagged {
		t.Fatalf("from --state-dir = %q", got)
	}
}

func TestConfigExportThenImportChangesNothing(t *testing.T) {
	resetRootConfigForTest(t)
	ctx := context.Background()
	state := t.TempDir()
	path := configstore.DBConfigPath(state)
	if err := configstore.WriteFileBy(path, []byte(precedenceConfig), configstore.ByImport); err != nil {
		t.Fatal(err)
	}
	db, err := agentdb.CachedStateDir(state).Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE settings SET updated_by = 'marker'`); err != nil {
		t.Fatal(err)
	}
	exported, err := configstore.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := configcmd.ImportDocument(path, exported); err != nil {
		t.Fatal(err)
	}
	again, err := configstore.ReadFile(path)
	if err != nil || string(again) != string(exported) {
		t.Fatalf("export after import differs:\n%s\nvs\n%s", again, exported)
	}
	var touched int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM settings WHERE updated_by != 'marker'`).Scan(&touched); err != nil || touched != 0 {
		t.Fatalf("import of the export touched %d settings rows, %v", touched, err)
	}
	if err := configcmd.ImportDocument(path, []byte("- a list\n")); err == nil {
		t.Fatal("a list imported as a config")
	}
}

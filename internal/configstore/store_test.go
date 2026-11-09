package configstore

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// realConfig has every collection in each of its shapes, values a column cannot hold, empty
// values written out, unknown keys and references.
const realConfig = `
user_agent: "agent/1.0"
llm:
  inference_provider: openai
  model: "gpt-5.4"
  api_key: "${OPENAI_API_KEY}"
  cache_key_prefix: ""
  temperature: 1.0
  reasoning_budget_tokens: 8192
  supports_image_parts: false
  abilities: ["text", "decision"]
  headers:
    X-Team: "${TEAM}"
    "-X-ABC-TOKEN": "${ABC_TOKEN}"
  azure:
    deployment: ""
  bedrock:
    aws_key: "${AWS_ACCESS_KEY_ID}"
    region: us-east-1
  cloudflare: {}
  pricing_file: "./pricing.yaml"
  image:
    request_timeout: "180s"
    options:
      openai: {}
  future_llm_key: [1, "two", {three: 3}]
  profiles:
    cheap:
      description: "Fast."
      inference_provider: openai
      model: gpt-4.1-mini
      api_key: "${secret:abc123}"
      context_window_tokens: 100000
      temperature: 0.2
      request_timeout: "15s"
      custom_key: keep-me
    empty: {}
    default:
      model: named-default
    painter:
      abilities: ["image"]
      temperature: "${TEMP}"
  routes:
    main_loop:
      candidates:
        - profile: default
          weight: 1
        - profile: cheap
          weight: 3
      fallback_profiles: ["painter"]
    decision:
      profile: cheap
      fallback_profiles: ["default"]
    awareness: cheap
    image: painter
    custom_purpose: cheap
    think:
      profile: cheap
      extra: 1
mcp:
  servers:
    - name: filesystem
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
      env:
        NODE_OPTIONS: "--max-old-space-size=4096"
      enable: true
      type: stdio
    - name: remote
      enable: false
      on_demand: true
      type: http
      url: "https://mcp.example.com/mcp"
      headers:
        Authorization: "Bearer ${MCP_REMOTE_TOKEN}"
      allowed_tools: ["search"]
      timeout: 30
console:
  listen: "127.0.0.1:9080"
  endpoints:
    - name: "Telegram Instance"
      url: "http://127.0.0.1:8787/runtime"
      auth_token: "${MISTER_MORPH_ENDPOINT_TELEGRAM_TOKEN}"
    - name: "Bare"
      url: ""
auth_profiles:
  jsonbill:
    credential:
      kind: api_key
      secret: "${JSONBILL_API_KEY}"
      note: x
    allow:
      url_prefixes: ["https://api.jsonbill.com/tasks/docs"]
      methods: ["POST"]
      follow_redirects: false
    bindings:
      url_fetch:
        inject:
          location: header
          name: Authorization
          format: bearer
  empty: {}
telegram:
  allowed_chat_ids: ["tg:@admin", "-1001"]
  group_trigger_mode: smart
tools:
  bash:
    enabled: true
    timeout: "30s"
  read_file:
    deny_paths: []
contacts:
  "dotted.key": 1
heartbeat:
  enabled: true
  interval: "30m"
unknown_section:
  nested:
    deeper: 0x1F
    list: []
  emoji: "🦊"
  nothing: null
`

func viperSettings(t *testing.T, data []byte) map[string]any {
	t.Helper()
	v := viper.New()
	v.SetConfigType("yaml")
	if err := v.ReadConfig(bytes.NewReader(data)); err != nil {
		t.Fatalf("viper: %v\n%s", err, data)
	}
	return v.AllSettings()
}

func roundTrip(t *testing.T, data []byte) []byte {
	t.Helper()
	path := DBConfigPath(t.TempDir())
	if err := WriteFileBy(path, data, ByCLI); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	out, err := ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	return out
}

// normalizeRoutes turns a route written as {profile: x} into x, as rendering does.
func normalizeRoutes(settings map[string]any) {
	llm, _ := settings["llm"].(map[string]any)
	routes, _ := llm["routes"].(map[string]any)
	for purpose, route := range routes {
		if m, ok := route.(map[string]any); ok && len(m) == 1 {
			if p, ok := m["profile"].(string); ok && isRoutePurpose(purpose) {
				routes[purpose] = p
			}
		}
	}
}

func TestExampleConfigRoundTripsThroughTheTables(t *testing.T) {
	example := ExampleYAML()
	out := roundTrip(t, example)
	want := viperSettings(t, example)
	got := viperSettings(t, out)
	normalizeRoutes(want)
	// The state folder is a bootstrap setting: agent.db does not keep it.
	for _, key := range BootstrapKeys {
		delete(want, key)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("example config differs after the round trip:\n%s", out)
	}
	// The rendered document follows the example's order.
	if !strings.HasPrefix(string(out), "user_agent:") || strings.Index(string(out), "\nllm:") > strings.Index(string(out), "\nlogging:") {
		t.Fatalf("rendered order:\n%s", out)
	}
	// Saving it again changes nothing.
	if again := roundTrip(t, out); !bytes.Equal(again, out) {
		t.Fatalf("second round trip differs:\n%s\nvs\n%s", again, out)
	}
}

func TestRealConfigRoundTripsThroughTheTables(t *testing.T) {
	path := DBConfigPath(t.TempDir())
	if err := WriteFileBy(path, []byte(realConfig), ByCLI); err != nil {
		t.Fatal(err)
	}
	out, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := viperSettings(t, []byte(realConfig))
	got := viperSettings(t, out)
	normalizeRoutes(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("real config differs after the round trip:\n%s", out)
	}
	for _, kept := range []string{`api_key: ${OPENAI_API_KEY}`, `api_key: ${secret:abc123}`, `secret: ${JSONBILL_API_KEY}`,
		`temperature: 1.0`, `cache_key_prefix: ""`, `emoji: "🦊"`, `custom_key: keep-me`, `deeper: 31`} {
		if !strings.Contains(string(out), kept) {
			t.Fatalf("rendered config lost %q:\n%s", kept, out)
		}
	}

	// The collections are rows of their tables.
	ctx := context.Background()
	db, err := agentdb.Cached(filepath.Join(filepath.Dir(path), "agent.db")).Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	count := func(query string, args ...any) int {
		t.Helper()
		var n int
		if err := db.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(`SELECT COUNT(*) FROM llm_profiles`); n != 4 {
		t.Fatalf("profiles = %d, want default, cheap, empty, painter", n)
	}
	if n := count(`SELECT COUNT(*) FROM llm_profiles WHERE name = 'cheap' AND api_key = '${secret:abc123}' AND context_window_tokens = 100000 AND temperature = 0.2`); n != 1 {
		t.Fatal("cheap profile columns")
	}
	if n := count(`SELECT COUNT(*) FROM llm_route_candidates WHERE purpose = 'main_loop'`); n != 2 {
		t.Fatalf("candidates = %d", n)
	}
	if n := count(`SELECT COUNT(*) FROM llm_routes WHERE purpose = 'awareness' AND profile = 'cheap'`); n != 1 {
		t.Fatal("awareness route")
	}
	if n := count(`SELECT COUNT(*) FROM mcp_servers WHERE name = 'remote' AND enabled = 0 AND on_demand = 1 AND type = 'http'`); n != 1 {
		t.Fatal("remote server columns")
	}
	if n := count(`SELECT COUNT(*) FROM console_endpoints`); n != 2 {
		t.Fatalf("endpoints = %d", n)
	}
	if n := count(`SELECT COUNT(*) FROM auth_profiles WHERE name = 'jsonbill' AND credential_secret = '${JSONBILL_API_KEY}'`); n != 1 {
		t.Fatal("auth profile")
	}
	if n := count(`SELECT COUNT(*) FROM settings WHERE path = 'telegram.allowed_chat_ids' AND kind = 'string_list'`); n != 1 {
		t.Fatal("telegram.allowed_chat_ids row")
	}
	if n := count(`SELECT COUNT(*) FROM settings WHERE path = 'unknown_section.nested.deeper'`); n != 1 {
		t.Fatal("unknown key row")
	}
}

func TestSaveChangesOnlyTheRowsItTouches(t *testing.T) {
	ctx := context.Background()
	path := DBConfigPath(t.TempDir())
	if err := WriteFileBy(path, []byte(realConfig), ByImport); err != nil {
		t.Fatal(err)
	}
	db, err := agentdb.Cached(filepath.Join(filepath.Dir(path), "agent.db")).Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Mark every row, then save a document with one value changed.
	for _, table := range []string{"settings", "llm_profiles", "llm_routes", "mcp_servers", "console_endpoints", "auth_profiles"} {
		if _, err := db.ExecContext(ctx, `UPDATE `+table+` SET updated_by = 'marker'`); err != nil {
			t.Fatal(err)
		}
	}
	changed := strings.Replace(realConfig, `group_trigger_mode: smart`, `group_trigger_mode: strict`, 1)
	changed = strings.Replace(changed, `model: gpt-4.1-mini`, `model: gpt-5-mini`, 1)
	if err := WriteFileBy(path, []byte(changed), ByConsole); err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(ctx, `SELECT 'settings', path FROM settings WHERE updated_by != 'marker'
		UNION ALL SELECT 'llm_profiles', name FROM llm_profiles WHERE updated_by != 'marker'
		UNION ALL SELECT 'other', purpose FROM llm_routes WHERE updated_by != 'marker'
		UNION ALL SELECT 'other', name FROM mcp_servers WHERE updated_by != 'marker'
		UNION ALL SELECT 'other', name FROM console_endpoints WHERE updated_by != 'marker'
		UNION ALL SELECT 'other', name FROM auth_profiles WHERE updated_by != 'marker'`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var touched []string
	for rows.Next() {
		var table, name string
		if err := rows.Scan(&table, &name); err != nil {
			t.Fatal(err)
		}
		touched = append(touched, table+":"+name)
	}
	if strings.Join(touched, ",") != "settings:telegram.group_trigger_mode,llm_profiles:cheap" {
		t.Fatalf("touched rows = %v", touched)
	}
}

func TestEmptyAgentDBHasNoConfig(t *testing.T) {
	path := DBConfigPath(t.TempDir())
	if exists, err := Exists(path); err != nil || exists {
		t.Fatalf("Exists = %v, %v", exists, err)
	}
	if _, err := ReadFile(path); !os.IsNotExist(err) {
		t.Fatalf("ReadFile err = %v, want not exist", err)
	}
	if err := WriteFileBy(path, []byte(""), ByCLI); err != nil {
		t.Fatal(err)
	}
	if exists, _ := Exists(path); !exists {
		t.Fatal("a saved empty config does not exist")
	}
}

func TestFileBackendWritesTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := WriteFile(path, []byte("llm:\n  model: m\n")); err != nil {
		t.Fatal(err)
	}
	raw, err := ReadFile(path)
	if err != nil || string(raw) != "llm:\n  model: m\n" {
		t.Fatalf("file = %q, %v", raw, err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}
	// No agent.db beside it.
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "agent.db")); !os.IsNotExist(err) {
		t.Fatalf("agent.db created for a file config: %v", err)
	}
	if Source(path) != "file" || Source(DBConfigPath("/x")) != "agent_db" {
		t.Fatal("Source")
	}
}

func TestImportFileOnce(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	file := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(file, []byte(realConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	ran, err := ImportFile(ctx, state, file)
	if err != nil || !ran {
		t.Fatalf("ImportFile = %v, %v", ran, err)
	}
	if _, err := os.Stat(file + ".imported"); err != nil {
		t.Fatalf("not renamed: %v", err)
	}
	out, err := ReadFile(DBConfigPath(state))
	if err != nil {
		t.Fatal(err)
	}
	want := viperSettings(t, []byte(realConfig))
	normalizeRoutes(want)
	// The file was beside config.yaml, which is in another folder than agent.db.
	want["llm"].(map[string]any)["pricing_file"] = filepath.Join(filepath.Dir(file), "pricing.yaml")
	if got := viperSettings(t, out); !reflect.DeepEqual(got, want) {
		t.Fatalf("imported config differs:\n%s", out)
	}
	// A file that shows up again is not imported over the saved config.
	if err := os.WriteFile(file, []byte("llm:\n  model: other\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if ran, err := ImportFile(ctx, state, file); err != nil || ran {
		t.Fatalf("second ImportFile = %v, %v", ran, err)
	}
	if _, err := ImportFile(ctx, t.TempDir(), writeTemp(t, "- not\n- a mapping\n")); err == nil {
		t.Fatal("a list config imported")
	}
}

// The import keeps a relative file setting pointing at the file beside the imported config.
func TestImportFileKeepsRelativeFileTargets(t *testing.T) {
	ctx := context.Background()
	t.Setenv("HOME", t.TempDir())
	config := func(pricing, keystore string) string {
		return "llm:\n  pricing_file: " + pricing + "\nmixin:\n  keystore_file: " + keystore + "\n"
	}
	read := func(t *testing.T, state string) (string, string) {
		t.Helper()
		out, err := ReadFile(DBConfigPath(state))
		if err != nil {
			t.Fatal(err)
		}
		v := viperSettings(t, out)
		pricing, _ := v["llm"].(map[string]any)["pricing_file"].(string)
		keystore, _ := v["mixin"].(map[string]any)["keystore_file"].(string)
		return pricing, keystore
	}

	t.Run("config folder is not the state folder", func(t *testing.T) {
		state := t.TempDir()
		file := writeTemp(t, config("./pricing.yaml", "credentials/mixin.json"))
		if ran, err := ImportFile(ctx, state, file); err != nil || !ran {
			t.Fatalf("ImportFile = %v, %v", ran, err)
		}
		pricing, keystore := read(t, state)
		dir := filepath.Dir(file)
		if pricing != filepath.Join(dir, "pricing.yaml") || keystore != filepath.Join(dir, "credentials", "mixin.json") {
			t.Fatalf("pricing_file = %q, keystore_file = %q, want them in %s", pricing, keystore, dir)
		}
	})
	t.Run("config folder is the state folder", func(t *testing.T) {
		state := t.TempDir()
		file := filepath.Join(state, "config.yaml")
		if err := os.WriteFile(file, []byte(config("./pricing.yaml", "credentials/mixin.json")), 0o600); err != nil {
			t.Fatal(err)
		}
		if ran, err := ImportFile(ctx, state, file); err != nil || !ran {
			t.Fatalf("ImportFile = %v, %v", ran, err)
		}
		if pricing, keystore := read(t, state); pricing != "./pricing.yaml" || keystore != "credentials/mixin.json" {
			t.Fatalf("pricing_file = %q, keystore_file = %q, want them as written", pricing, keystore)
		}
	})
	t.Run("absolute, home, reference and empty paths", func(t *testing.T) {
		state := t.TempDir()
		file := writeTemp(t, config("~/pricing.yaml", "/etc/morph/mixin.json")+"tools:\n  bash:\n    timeout: 30s\n")
		if ran, err := ImportFile(ctx, state, file); err != nil || !ran {
			t.Fatalf("ImportFile = %v, %v", ran, err)
		}
		if pricing, keystore := read(t, state); pricing != "~/pricing.yaml" || keystore != "/etc/morph/mixin.json" {
			t.Fatalf("pricing_file = %q, keystore_file = %q, want them as written", pricing, keystore)
		}

		state = t.TempDir()
		file = writeTemp(t, config(`"${FT36_PRICING}"`, `""`))
		if ran, err := ImportFile(ctx, state, file); err != nil || !ran {
			t.Fatalf("ImportFile = %v, %v", ran, err)
		}
		rows, err := Settings(ctx, state)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]string{}
		for _, row := range rows {
			got[row[0]] = row[2]
		}
		if got["llm.pricing_file"] != `"${FT36_PRICING}"` || got["mixin.keystore_file"] != `""` {
			t.Fatalf("settings = %v, want the reference and the empty path as written", got)
		}
	})
	t.Run("a path that is not a string", func(t *testing.T) {
		state := t.TempDir()
		file := writeTemp(t, "mixin:\n  keystore_file: [a, b]\n")
		if ran, err := ImportFile(ctx, state, file); err != nil || !ran {
			t.Fatalf("ImportFile = %v, %v", ran, err)
		}
		out, err := ReadFile(DBConfigPath(state))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(out), "- a") {
			t.Fatalf("a list keystore_file was not kept as written:\n%s", out)
		}
	})
}

// Saving a config to agent.db (the Console, morph config import) keeps relative paths as written:
// they resolve from the state folder, as they did before the save.
func TestWriteFileKeepsRelativeFileSettings(t *testing.T) {
	path := DBConfigPath(t.TempDir())
	if err := WriteFileBy(path, []byte("llm:\n  pricing_file: ./pricing.yaml\n"), ByCLI); err != nil {
		t.Fatal(err)
	}
	out, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "pricing_file: ./pricing.yaml") {
		t.Fatalf("saved config:\n%s", out)
	}
}

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

var _ = yaml.Node{}

// An edit of the config in agent.db that moves the state folder is refused with the reason; the
// folder agent.db is in, however spelled, is accepted; a whole document written in drops it.
func TestBootstrapKeyIsRefusedNotDropped(t *testing.T) {
	state := t.TempDir()
	path := DBConfigPath(state)
	other := filepath.Join(t.TempDir(), "elsewhere")

	err := CheckBootstrapKeys(path, []byte("file_state_dir: "+other+"\nlogging:\n  level: warn\n"))
	var bootstrap *BootstrapKeyError
	if !errors.As(err, &bootstrap) || bootstrap.Key != "file_state_dir" || bootstrap.StateDir != state || bootstrap.Value != other {
		t.Fatalf("err = %v, want a BootstrapKeyError for %s", err, state)
	}
	if msg := err.Error(); !strings.Contains(msg, "--state-dir") || !strings.Contains(msg, "MISTER_MORPH_FILE_STATE_DIR") {
		t.Fatalf("message does not say how to move the state folder: %s", msg)
	}
	for _, same := range []string{state, state + "/", filepath.Join(state, "."), ""} {
		if err := CheckBootstrapKeys(path, []byte("file_state_dir: \""+same+"\"\n")); err != nil {
			t.Fatalf("file_state_dir %q: %v", same, err)
		}
	}
	file := filepath.Join(t.TempDir(), "config.yaml")
	if err := CheckBootstrapKeys(file, []byte("file_state_dir: "+other+"\n")); err != nil {
		t.Fatalf("a file config may set file_state_dir: %v", err)
	}

	if err := WriteFileBy(path, []byte("file_state_dir: "+other+"\nlogging:\n  level: info\n"), ByImport); err != nil {
		t.Fatalf("import: %v", err)
	}
	out, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "file_state_dir") || !strings.Contains(string(out), "level: info") {
		t.Fatalf("config =\n%s", out)
	}
}

// A read sees one save, never the tables of two: the settings, profiles, routes and MCP servers
// of a config read while other saves alternate all come from the same document.
func TestConcurrentReadsSeeOneSave(t *testing.T) {
	path := DBConfigPath(t.TempDir())
	doc := func(v string) []byte {
		return []byte(`llm:
  model: model-` + v + `
  profiles:
    alt:
      model: alt-` + v + `
  routes:
    decision: alt
mcp:
  servers:
    - name: srv-` + v + `
      command: run-` + v + `
review_marker: ` + v + `
`)
	}
	if err := WriteFileBy(path, doc("a"), ByCLI); err != nil {
		t.Fatal(err)
	}
	type parsed struct {
		LLM struct {
			Model    string `yaml:"model"`
			Profiles map[string]struct {
				Model string `yaml:"model"`
			} `yaml:"profiles"`
		} `yaml:"llm"`
		MCP struct {
			Servers []struct {
				Name    string `yaml:"name"`
				Command string `yaml:"command"`
			} `yaml:"servers"`
		} `yaml:"mcp"`
		Marker string `yaml:"review_marker"`
	}
	stop := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		defer close(writerDone)
		for i := 0; i < 150; i++ {
			v := "a"
			if i%2 == 0 {
				v = "b"
			}
			if err := WriteFileBy(path, doc(v), ByCLI); err != nil {
				writerDone <- err
				return
			}
		}
	}()
	errs := make(chan error, 4)
	for r := 0; r < 4; r++ {
		go func() {
			for {
				select {
				case <-stop:
					errs <- nil
					return
				default:
				}
				raw, err := ReadFile(path)
				if err != nil {
					errs <- err
					return
				}
				var p parsed
				if err := yaml.Unmarshal(raw, &p); err != nil {
					errs <- err
					return
				}
				v := p.Marker
				ok := p.LLM.Model == "model-"+v && p.LLM.Profiles["alt"].Model == "alt-"+v &&
					len(p.MCP.Servers) == 1 && p.MCP.Servers[0].Name == "srv-"+v && p.MCP.Servers[0].Command == "run-"+v
				if !ok {
					errs <- errors.New("read mixes two saves:\n" + string(raw))
					return
				}
			}
		}()
	}
	if err := <-writerDone; err != nil {
		t.Fatal(err)
	}
	close(stop)
	for r := 0; r < 4; r++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}

// An import that committed but could not rename its file (a crash, a folder it cannot write)
// finishes the rename on the next call, without parsing the file again: a file broken since does
// not stop the config in agent.db from loading.
func TestImportFileFinishesAnInterruptedRename(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root renames in a read-only folder")
	}
	ctx := context.Background()
	state := t.TempDir()
	folder := t.TempDir()
	file := filepath.Join(folder, "config.yaml")
	if err := os.WriteFile(file, []byte("llm:\n  model: imported\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(folder, 0o500); err != nil {
		t.Fatal(err)
	}
	ran, err := ImportFile(ctx, state, file)
	if err := os.Chmod(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if !ran || err == nil {
		t.Fatalf("ImportFile in a read-only folder = %v, %v; want imported with a rename error", ran, err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("file gone after a failed rename: %v", err)
	}
	// The file breaks before the next start.
	if err := os.WriteFile(file, []byte("llm: [\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if ran, err := ImportFile(ctx, state, file); err != nil || ran {
		t.Fatalf("ImportFile after the interruption = %v, %v; want the rename finished, nothing imported", ran, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("file still in place: %v", err)
	}
	if raw, err := os.ReadFile(file + ".imported"); err != nil || string(raw) != "llm: [\n" {
		t.Fatalf("imported copy = %q, %v", raw, err)
	}
	out, err := ReadFile(DBConfigPath(state))
	if err != nil || !strings.Contains(string(out), "model: imported") {
		t.Fatalf("config = %s, %v", out, err)
	}
	// Nothing is pending any more: a new file at the path is left alone.
	if err := os.WriteFile(file, []byte("llm: [\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if ran, err := ImportFile(ctx, state, file); err != nil || ran {
		t.Fatalf("ImportFile of a new broken file = %v, %v", ran, err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("a new file was renamed: %v", err)
	}
}

package consolecmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

// The Tools page's agent name set saves through PUT /settings/agent with the tool switches and
// reads back from GET; missing and unknown stored values read as the scientists.
func TestAgentSettingsAgentNameSet(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	prevConfig, hadConfig := viper.Get("config"), viper.IsSet("config")
	prevTools, hadTools := viper.Get("tools"), viper.IsSet("tools")
	viper.Set("config", configPath)
	t.Cleanup(func() {
		if hadConfig {
			viper.Set("config", prevConfig)
		} else {
			viper.Set("config", nil)
		}
		if hadTools {
			viper.Set("tools", prevTools)
		} else {
			viper.Set("tools", nil)
		}
	})
	writeConfig := func(text string) {
		t.Helper()
		if err := os.WriteFile(configPath, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	call := func(method, body string) (int, string) {
		t.Helper()
		var reader *bytes.Buffer
		if body != "" {
			reader = bytes.NewBufferString(body)
		} else {
			reader = &bytes.Buffer{}
		}
		rec := httptest.NewRecorder()
		(&server{}).handleAgentSettings(rec, httptest.NewRequest(method, "/api/settings/agent", reader))
		if rec.Code != http.StatusOK {
			return rec.Code, ""
		}
		var payload struct {
			Tools toolsSettingsPayload `json:"tools"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("unmarshal: %v (%s)", err, rec.Body.String())
		}
		return rec.Code, payload.Tools.AgentNameSet
	}

	for name, config := range map[string]string{
		"missing": "llm:\n  provider: openai\n  model: gpt-5.2\n",
		"unknown": "llm:\n  provider: openai\n  model: gpt-5.2\ntools:\n  agent_name_set: poets\n",
		"empty":   "llm:\n  provider: openai\n  model: gpt-5.2\ntools:\n  agent_name_set: \"\"\n",
	} {
		t.Run(name, func(t *testing.T) {
			writeConfig(config)
			if code, set := call(http.MethodGet, ""); code != http.StatusOK || set != "scientists" {
				t.Fatalf("GET = %d %q, want scientists", code, set)
			}
			got, err := readAgentSettings(configPath)
			if err != nil || got.Tools.AgentNameSet != "scientists" {
				t.Fatalf("readAgentSettings = %q, %v", got.Tools.AgentNameSet, err)
			}
		})
	}

	t.Run("save and reload", func(t *testing.T) {
		writeConfig("llm:\n  provider: openai\n  model: gpt-5.2\ntools:\n  spawn:\n    enabled: true\n")
		code, set := call(http.MethodPut, `{"tools":{"spawn":{"enabled":true},"agent_name_set":"musicians"}}`)
		if code != http.StatusOK || set != "musicians" {
			t.Fatalf("PUT = %d %q", code, set)
		}
		raw, _ := os.ReadFile(configPath)
		if !strings.Contains(string(raw), "agent_name_set: musicians") || !strings.Contains(string(raw), "provider: openai") {
			t.Fatalf("config = %s", raw)
		}
		if code, set := call(http.MethodGet, ""); code != http.StatusOK || set != "musicians" {
			t.Fatalf("GET after save = %d %q", code, set)
		}
		// Saving the tool switches alone keeps the set.
		if code, set := call(http.MethodPut, `{"tools":{"bash":{"enabled":false}}}`); code != http.StatusOK || set != "musicians" {
			t.Fatalf("PUT without the set = %d %q", code, set)
		}
		if code, set := call(http.MethodPut, `{"tools":{"agent_name_set":" Artists "}}`); code != http.StatusOK || set != "artists" {
			t.Fatalf("PUT artists = %d %q", code, set)
		}
		// The runtime reads the saved set for the next generation.
		reader := viper.New()
		reader.SetConfigFile(configPath)
		if err := reader.ReadInConfig(); err != nil {
			t.Fatal(err)
		}
		if got := consoleEngineToolsConfigFromReader(reader).WorkerNameSet; got != "artists" {
			t.Fatalf("engine name set = %q", got)
		}
	})

	t.Run("an unknown set is rejected", func(t *testing.T) {
		writeConfig("llm:\n  provider: openai\n  model: gpt-5.2\ntools:\n  agent_name_set: musicians\n")
		if code, _ := call(http.MethodPut, `{"tools":{"agent_name_set":"poets"}}`); code != http.StatusBadRequest {
			t.Fatalf("PUT poets = %d, want 400", code)
		}
		raw, _ := os.ReadFile(configPath)
		if !strings.Contains(string(raw), "agent_name_set: musicians") {
			t.Fatalf("config changed: %s", raw)
		}
	})
}

func TestConsoleEngineToolsConfigReadsAgentNameSet(t *testing.T) {
	reader := viper.New()
	if got := consoleEngineToolsConfigFromReader(reader).WorkerNameSet; got != "scientists" {
		t.Fatalf("default = %q", got)
	}
	for value, want := range map[string]string{"musicians": "musicians", "ARTISTS": "artists", "poets": "scientists"} {
		reader.Set("tools.agent_name_set", value)
		if got := consoleEngineToolsConfigFromReader(reader).WorkerNameSet; got != want {
			t.Fatalf("%q = %q, want %q", value, got, want)
		}
	}
}

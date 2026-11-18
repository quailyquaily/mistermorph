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

// The Tools page switches job_manage as tools.job_manage.enabled. A config that still has the
// earlier tools.todo_update.enabled is honored until job_manage is set, and kept in step when it
// is; a client that sends the earlier name still switches the tool.
func TestAgentSettingsJobManageSwitch(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	prevConfig, hadConfig := viper.Get("config"), viper.IsSet("config")
	viper.Set("config", configPath)
	t.Cleanup(func() {
		if hadConfig {
			viper.Set("config", prevConfig)
		} else {
			viper.Set("config", nil)
		}
	})
	writeConfig := func(text string) {
		t.Helper()
		if err := os.WriteFile(configPath, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	type switches struct {
		JobManage  struct{ Enabled bool } `json:"job_manage"`
		TodoUpdate struct{ Enabled bool } `json:"todo_update"`
	}
	call := func(method, body string) switches {
		t.Helper()
		rec := httptest.NewRecorder()
		(&server{}).handleAgentSettings(rec, httptest.NewRequest(method, "/api/settings/agent", bytes.NewBufferString(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s = %d %s", method, rec.Code, rec.Body.String())
		}
		var payload struct {
			Tools switches `json:"tools"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Tools
	}
	const llm = "llm:\n  provider: openai\n  model: gpt-5.2\n"

	writeConfig(llm)
	if got := call(http.MethodGet, ""); !got.JobManage.Enabled || !got.TodoUpdate.Enabled {
		t.Fatalf("default = %+v", got)
	}

	writeConfig(llm + "tools:\n  todo_update:\n    enabled: false\n")
	if got := call(http.MethodGet, ""); got.JobManage.Enabled || got.TodoUpdate.Enabled {
		t.Fatalf("legacy off = %+v", got)
	}
	if got := call(http.MethodPut, `{"tools":{"job_manage":{"enabled":true}}}`); !got.JobManage.Enabled || !got.TodoUpdate.Enabled {
		t.Fatalf("after switching on = %+v", got)
	}
	raw, _ := os.ReadFile(configPath)
	if !strings.Contains(string(raw), "job_manage:\n        enabled: true") && !strings.Contains(string(raw), "job_manage:\n    enabled: true") {
		t.Fatalf("job_manage not written:\n%s", raw)
	}
	if strings.Contains(string(raw), "enabled: false") {
		t.Fatalf("the earlier switch was left off:\n%s", raw)
	}

	writeConfig(llm)
	if got := call(http.MethodPut, `{"tools":{"todo_update":{"enabled":false}}}`); got.JobManage.Enabled {
		t.Fatalf("the earlier name did not switch the tool off: %+v", got)
	}
	raw, _ = os.ReadFile(configPath)
	if !strings.Contains(string(raw), "job_manage:") || strings.Contains(string(raw), "todo_update:") {
		t.Fatalf("config = %s", raw)
	}
}

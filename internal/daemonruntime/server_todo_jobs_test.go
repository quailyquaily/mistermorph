package daemonruntime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/spf13/viper"
)

func todoJobsMux(t *testing.T, stateDir string) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	settings := viper.New()
	settings.Set("file_state_dir", stateDir)
	settings.Set("llm.inference_provider", "openai")
	settings.Set("llm.model", "default-model")
	RegisterRoutes(mux, RoutesOptions{Mode: "serve", AuthToken: "token", AgentSettingsReader: settings, RuntimePaths: testRuntimePaths(stateDir)})
	return mux
}

type todoJobsPayload struct {
	Revision int64            `json:"revision"`
	Tasks    []cronstore.Task `json:"tasks"`
}

func todoJobsCall(t *testing.T, mux *http.ServeMux, method, body string) (int, todoJobsPayload, string) {
	t.Helper()
	req := httptest.NewRequest(method, "/todo/tasks", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var payload todoJobsPayload
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code, payload, rec.Body.String()
}

// The Console saves the list it read: a save of an older revision is refused, so a job a tool
// added meanwhile (in this process or another) is not dropped.
func TestTodoTasksSaveRefusesAListThatChangedSinceItWasRead(t *testing.T) {
	stateDir := t.TempDir()
	mux := todoJobsMux(t, stateDir)
	code, read, body := todoJobsCall(t, mux, http.MethodGet, "")
	if code != http.StatusOK || len(read.Tasks) != 0 {
		t.Fatalf("GET = %d %s", code, body)
	}
	code, saved, body := todoJobsCall(t, mux, http.MethodPut,
		`{"revision":0,"tasks":[{"id":"job-11111111-2222-4333-8444-555555555555","cron":"0 9 * * *","content":"a"},{"cron":"0 10 * * *","content":"no id yet"}]}`)
	if code != http.StatusOK || saved.Revision != 1 || len(saved.Tasks) != 2 {
		t.Fatalf("PUT = %d %s", code, body)
	}
	// A new job sent without an ID gets a generated one; the one sent keeps its own.
	_, read, _ = todoJobsCall(t, mux, http.MethodGet, "")
	if read.Tasks[0].ID != "job-11111111-2222-4333-8444-555555555555" || !cronstore.IsGeneratedJobID(read.Tasks[1].ID) || read.Revision != 1 {
		t.Fatalf("GET after save = %+v", read)
	}

	// A tool adds a job.
	if _, err := cronstore.NewStore(filepath.Join(stateDir, "cron.yaml")).AddRecurring(cronstore.Task{Cron: "* * * * *", Content: "from a tool"}); err != nil {
		t.Fatal(err)
	}
	stale := `{"revision":1,"tasks":[{"id":"job-11111111-2222-4333-8444-555555555555","cron":"0 9 * * *","content":"edited"}]}`
	if code, _, body := todoJobsCall(t, mux, http.MethodPut, stale); code != http.StatusConflict || !strings.Contains(body, "changed since it was read") {
		t.Fatalf("stale PUT = %d %s", code, body)
	}
	_, read, _ = todoJobsCall(t, mux, http.MethodGet, "")
	if len(read.Tasks) != 3 || read.Tasks[2].Content != "from a tool" || read.Revision != 2 {
		t.Fatalf("list after a refused save = %+v", read)
	}
	// A client that sends no revision (an earlier Console) still saves.
	if code, _, body := todoJobsCall(t, mux, http.MethodPut, `{"tasks":[]}`); code != http.StatusOK {
		t.Fatalf("PUT without revision = %d %s", code, body)
	}
}

// A cron.yaml that cannot be imported whole is reported, with every rejected record, rather than
// shown as an empty list.
func TestTodoTasksReportsAFailedImport(t *testing.T) {
	stateDir := t.TempDir()
	raw := "version: 1\ntasks:\n  - cron: \"* * * * *\"\n    content: no id\n"
	if err := os.WriteFile(filepath.Join(stateDir, "cron.yaml"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	mux := todoJobsMux(t, stateDir)
	code, _, body := todoJobsCall(t, mux, http.MethodGet, "")
	if code != http.StatusConflict || !strings.Contains(body, "record 1: task id is missing") {
		t.Fatalf("GET = %d %s", code, body)
	}
	if code, _, _ := todoJobsCall(t, mux, http.MethodPut, `{"tasks":[]}`); code != http.StatusConflict {
		t.Fatalf("PUT during a failed import = %d", code)
	}
}

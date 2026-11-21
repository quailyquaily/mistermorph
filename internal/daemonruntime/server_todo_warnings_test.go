package daemonruntime

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

// GET /todo/tasks (and the answer of a PUT) tells a client about a job that joins all of inputs
// no single run leads to. The warnings are worked out for the answer: they are not stored, and a
// client that sends them back has them ignored.
func TestTodoTasksRouteWarnsAboutAJoinThatNeverStarts(t *testing.T) {
	stateDir := t.TempDir()
	do := personaTestMux(t, stateDir)
	type answer struct {
		Tasks []struct {
			ID       string   `json:"id"`
			Warnings []string `json:"warnings"`
		} `json:"tasks"`
	}
	read := func(body []byte) map[string][]string {
		t.Helper()
		var got answer
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("answer: %v\n%s", err, body)
		}
		out := map[string][]string{}
		for _, task := range got.Tasks {
			if task.Warnings != nil {
				out[task.ID] = task.Warnings
			}
		}
		return out
	}
	body := `{"tasks":[
		{"id":"a","content":"a","triggers":[]},
		{"id":"b","content":"b","triggers":[]},
		{"id":"d","content":"d","triggers":[],"join":"all","uses":[{"job_id":"a","mode":"each"},{"job_id":"b","mode":"each"}],
		 "warnings":["a client's own text"]}
	]}`
	rec := do(http.MethodPut, "/todo/tasks", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /todo/tasks = %d %s", rec.Code, rec.Body.String())
	}
	for name, raw := range map[string][]byte{"PUT": rec.Body.Bytes(), "GET": do(http.MethodGet, "/todo/tasks", "").Body.Bytes()} {
		warnings := read(raw)
		if len(warnings) != 1 || len(warnings["d"]) != 1 || !strings.Contains(warnings["d"][0], "never starts") || !strings.Contains(warnings["d"][0], "a, b") {
			t.Fatalf("%s warnings = %v", name, warnings)
		}
		// A job without a warning has no key at all.
		if strings.Count(string(raw), `"warnings"`) != 1 || strings.Contains(string(raw), "a client's own text") {
			t.Fatalf("%s answer = %s", name, raw)
		}
	}
	// Nothing of it is stored.
	stored, err := cronstore.NewStore(filepath.Join(stateDir, "cron.yaml")).Tasks(t.Context())
	if err != nil || len(stored) != 3 {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
	// With join any, or a common upstream job, the warning is gone.
	fixed := `{"tasks":[
		{"id":"a","content":"a","triggers":[]},
		{"id":"b","content":"b","triggers":[],"uses":[{"job_id":"a","mode":"each"}]},
		{"id":"d","content":"d","triggers":[],"uses":[{"job_id":"a","mode":"each"},{"job_id":"b","mode":"each"}]}
	]}`
	if rec := do(http.MethodPut, "/todo/tasks", fixed); rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), `"warnings"`) {
		t.Fatalf("PUT fixed = %d %s", rec.Code, rec.Body.String())
	}
	if raw := do(http.MethodGet, "/todo/tasks", "").Body.String(); strings.Contains(raw, `"warnings"`) {
		t.Fatalf("GET fixed = %s", raw)
	}
}

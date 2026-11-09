package daemonruntime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func personaTestMux(t *testing.T, stateDir string) func(method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{Mode: "serve", AuthToken: "token", RuntimePaths: testRuntimePaths(stateDir)})
	return func(method, target, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
}

func stateFileExists(t *testing.T, do func(string, string, string) *httptest.ResponseRecorder, name string) bool {
	t.Helper()
	rec := do(http.MethodGet, "/state/files", "")
	var payload struct {
		Items []struct {
			Name   string `json:"name"`
			Exists bool   `json:"exists"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, item := range payload.Items {
		if item.Name == name {
			return item.Exists
		}
	}
	t.Fatalf("%s not listed: %s", name, rec.Body.String())
	return false
}

func TestPersonaFileRoutesRenderAndParseRows(t *testing.T) {
	stateDir := t.TempDir()
	do := personaTestMux(t, stateDir)

	if stateFileExists(t, do, "identity.yaml") || stateFileExists(t, do, "soul.md") {
		t.Fatal("empty state reports persona files")
	}
	if rec := do(http.MethodGet, "/persona/files/identity.yaml", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("missing identity = %d", rec.Code)
	}
	put := func(target, content string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"content": content})
		if rec := do(http.MethodPut, target, string(body)); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s = %d %s", target, rec.Code, rec.Body.String())
		}
	}
	put("/persona/files/identity.yaml", "name: Momo\ncreature: cat\nhome: attic\n")
	put("/persona/files/soul.md", "# Soul\n\nPurr.\n")
	if !stateFileExists(t, do, "identity.yaml") || !stateFileExists(t, do, "soul.md") {
		t.Fatal("saved persona not reported")
	}
	rec := do(http.MethodGet, "/persona/files/identity.yaml", "")
	var file struct {
		Content string `json:"content"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &file)
	if file.Content != "name: Momo\nname_alts: []\ncreature: cat\nvibe: \"\"\nemoji: \"\"\nhome: attic\n" {
		t.Fatalf("identity.yaml = %q", file.Content)
	}
	rec = do(http.MethodGet, "/persona/identity", "")
	var payload struct {
		Exists   bool `json:"exists"`
		Identity struct {
			Name  string         `json:"name"`
			Soul  string         `json:"soul"`
			Extra map[string]any `json:"extra"`
		} `json:"identity"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Exists || payload.Identity.Name != "Momo" || payload.Identity.Soul != "# Soul\n\nPurr." || payload.Identity.Extra["home"] != "attic" {
		t.Fatalf("identity = %s", rec.Body.String())
	}
	if rec := do(http.MethodPut, "/persona/identity", `{"vibe":"sleepy","soul":""}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT identity = %d %s", rec.Code, rec.Body.String())
	}
	if stateFileExists(t, do, "soul.md") {
		t.Fatal("cleared soul still reported")
	}
	if rec := do(http.MethodPut, "/persona/identity", `{"unknown":1}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown field = %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "persona", "identity.yaml")); !os.IsNotExist(err) {
		t.Fatalf("a persona file was written: %v", err)
	}
}

func TestHeartbeatRoutes(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "HEARTBEAT.md"), []byte("## Inbox\n\n- Read it.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	do := personaTestMux(t, stateDir)
	type listing struct {
		Items []struct {
			ID           string `json:"id"`
			Title        string `json:"title"`
			Instructions string `json:"instructions"`
			Enabled      bool   `json:"enabled"`
		} `json:"items"`
		Task      string `json:"task"`
		TaskEmpty bool   `json:"task_empty"`
	}
	list := func() listing {
		t.Helper()
		rec := do(http.MethodGet, "/heartbeat/workflows", "")
		var out listing
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("%v: %s", err, rec.Body.String())
		}
		return out
	}
	got := list()
	if len(got.Items) != 1 || got.Items[0].Title != "Inbox" || got.Task != "## Inbox\n\n- Read it." {
		t.Fatalf("imported = %+v", got)
	}
	if rec := do(http.MethodPost, "/heartbeat/workflows", `{"title":"Calendar","instructions":"- Look ahead.","position":0}`); rec.Code != http.StatusCreated {
		t.Fatalf("POST = %d %s", rec.Code, rec.Body.String())
	}
	got = list()
	if len(got.Items) != 2 || got.Items[0].Title != "Calendar" {
		t.Fatalf("after add = %+v", got)
	}
	inboxID := got.Items[1].ID
	if rec := do(http.MethodPatch, "/heartbeat/workflows/"+inboxID, `{"enabled":false}`); rec.Code != http.StatusOK {
		t.Fatalf("PATCH = %d %s", rec.Code, rec.Body.String())
	}
	if got = list(); got.Task != "## Calendar\n\n- Look ahead." {
		t.Fatalf("task with inbox off = %q", got.Task)
	}
	// The checklist route renders the off workflow and parses it back unchanged.
	rec := do(http.MethodGet, "/state/files/HEARTBEAT.md", "")
	var file struct {
		Content string `json:"content"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &file)
	if !strings.Contains(file.Content, "## [off] Inbox") {
		t.Fatalf("checklist = %q", file.Content)
	}
	body, _ := json.Marshal(map[string]string{"content": file.Content})
	if rec := do(http.MethodPut, "/state/files/HEARTBEAT.md", string(body)); rec.Code != http.StatusOK {
		t.Fatalf("PUT checklist = %d %s", rec.Code, rec.Body.String())
	}
	after := list()
	if len(after.Items) != 2 || after.Items[1].ID != inboxID || after.Items[1].Enabled {
		t.Fatalf("after checklist save = %+v", after)
	}
	if rec := do(http.MethodPut, "/heartbeat/workflows", `{"items":[]}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT empty = %d", rec.Code)
	}
	if got = list(); len(got.Items) != 0 || !got.TaskEmpty {
		t.Fatalf("after clearing = %+v", got)
	}
	if rec := do(http.MethodDelete, "/heartbeat/workflows/"+inboxID, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("DELETE missing = %d", rec.Code)
	}
}

func TestTodoRoutesKeepOrderAndRenderCronYAML(t *testing.T) {
	stateDir := t.TempDir()
	do := personaTestMux(t, stateDir)
	body := `{"tasks":[{"id":"z","cron":"0 9 * * *","content":"last letter first"},{"id":"a","at":"2030-01-02 09:00","tz":"UTC","content":"then a"}]}`
	if rec := do(http.MethodPut, "/todo/tasks", body); rec.Code != http.StatusOK {
		t.Fatalf("PUT /todo/tasks = %d %s", rec.Code, rec.Body.String())
	}
	rec := do(http.MethodGet, "/todo/tasks", "")
	var listed struct {
		Tasks []struct {
			ID string `json:"id"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed.Tasks) != 2 || listed.Tasks[0].ID != "z" {
		t.Fatalf("GET /todo/tasks = %s", rec.Body.String())
	}
	if rec := do(http.MethodPut, "/todo/tasks", `{"tasks":[{"id":"bad","content":"no schedule"}]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid list = %d", rec.Code)
	}
	rec = do(http.MethodGet, "/todo/files/cron.yaml", "")
	var file struct {
		Content string `json:"content"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &file)
	if !strings.HasPrefix(file.Content, "version: 1\ntasks:\n    - id: z\n") {
		t.Fatalf("cron.yaml = %q", file.Content)
	}
	edited, _ := json.Marshal(map[string]string{"content": "version: 1\ntasks:\n  - id: a\n    cron: \"*/5 * * * *\"\n    content: only a\n"})
	if rec := do(http.MethodPut, "/todo/files/cron.yaml", string(edited)); rec.Code != http.StatusOK {
		t.Fatalf("PUT cron.yaml = %d %s", rec.Code, rec.Body.String())
	}
	rec = do(http.MethodGet, "/todo/tasks", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed.Tasks) != 1 || listed.Tasks[0].ID != "a" {
		t.Fatalf("after raw save = %s", rec.Body.String())
	}
	bad, _ := json.Marshal(map[string]string{"content": "tasks: [unclosed"})
	if rec := do(http.MethodPut, "/todo/files/cron.yaml", string(bad)); rec.Code != http.StatusBadRequest {
		t.Fatalf("unparsable cron.yaml = %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "cron.yaml")); !os.IsNotExist(err) {
		t.Fatalf("cron.yaml written: %v", err)
	}
}

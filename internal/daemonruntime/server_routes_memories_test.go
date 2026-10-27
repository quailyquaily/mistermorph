package daemonruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/domainjournal"
	"github.com/quailyquaily/mistermorph/internal/memories"
)

func memoryRoutesMux(t *testing.T) (*http.ServeMux, string) {
	t.Helper()
	stateDir := t.TempDir()
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{AuthToken: "token", RuntimePaths: testRuntimePaths(stateDir)})
	return mux, stateDir
}

func serve(t *testing.T, mux *http.ServeMux, method, target, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func TestMemoryRoutes(t *testing.T) {
	mux, stateDir := memoryRoutesMux(t)
	paths := testRuntimePaths(stateDir)
	store, err := memories.Open(context.Background(), paths.MemoryDBPath)
	if err != nil {
		t.Fatalf("memories.Open() error = %v", err)
	}
	saved, err := store.Save(context.Background(), audience.Conversation("tg:-100"), memories.Draft{
		Subject: "conversation:tg:-100", Name: "standup", Type: memories.TypeContext, Description: "Standup at ten", Body: "The group meets at 10:00 JST.",
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	_ = store.Close()

	rec, out := serve(t, mux, http.MethodGet, "/memories", "")
	if rec.Code != http.StatusOK || len(out["items"].([]any)) != 1 {
		t.Fatalf("GET /memories = %d %v", rec.Code, out)
	}
	for _, tc := range []struct {
		hearAs string
		heard  int
	}{
		{"owner", 1},
		{"conversation:tg:-100", 1},
		{"conversation:tg:-200", 0},
		{"contact:alice", 0},
	} {
		rec, out := serve(t, mux, http.MethodGet, "/memories?hear_as="+tc.hearAs, "")
		heard, _ := out["heard"].([]any)
		if rec.Code != http.StatusOK || len(out["items"].([]any)) != 1 || len(heard) != tc.heard || out["hear_as"] != tc.hearAs {
			t.Fatalf("GET /memories?hear_as=%s = %d %v, want %d heard of all items", tc.hearAs, rec.Code, out, tc.heard)
		}
	}
	if rec, _ := serve(t, mux, http.MethodGet, "/memories?hear_as=somebody", ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("GET /memories with a bad hear_as = %d, want 400", rec.Code)
	}
	rec, out = serve(t, mux, http.MethodGet, "/memories?q=standup", "")
	if rec.Code != http.StatusOK || len(out["items"].([]any)) != 1 {
		t.Fatalf("GET /memories?q = %d %v", rec.Code, out)
	}
	rec, out = serve(t, mux, http.MethodPut, "/memories", `{"id":"`+saved.Memory.ID+`","visibility":"public","body":"The group meets at 10:30 JST."}`)
	item, _ := out["item"].(map[string]any)
	if rec.Code != http.StatusOK || item["visibility"] != "public" || item["body"] != "The group meets at 10:30 JST." {
		t.Fatalf("PUT /memories = %d %v, want the owner to widen it", rec.Code, out)
	}
	if rec, _ := serve(t, mux, http.MethodPut, "/memories", `{"id":"`+saved.Memory.ID+`","visibility":"secret"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("PUT /memories with a bad visibility = %d, want 400", rec.Code)
	}
	if rec, _ := serve(t, mux, http.MethodDelete, "/memories?id="+saved.Memory.ID, ""); rec.Code != http.StatusOK {
		t.Fatalf("DELETE /memories = %d", rec.Code)
	}
	if rec, _ := serve(t, mux, http.MethodDelete, "/memories?id="+saved.Memory.ID, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("second DELETE /memories = %d, want 404", rec.Code)
	}
}

func TestJournalSearchRoute(t *testing.T) {
	mux, stateDir := memoryRoutesMux(t)
	journal, err := domainjournal.New(domainjournal.JournalOptions{Dir: testRuntimePaths(stateDir).JournalDir})
	if err != nil {
		t.Fatalf("domainjournal.New() error = %v", err)
	}
	if _, err := journal.Append(domainjournal.Event{
		ID: "evt_1", Time: "2026-10-01T10:00:00Z", Domain: "task", Type: "task_upsert", SchemaVersion: 1,
		Audience: "contact:tg:@alice", Payload: json.RawMessage(`{"task":{"id":"t1","task":"where is the budget sheet"}}`),
	}); err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	_ = journal.Close()

	rec, out := serve(t, mux, http.MethodGet, "/journal/search?q=budget&since=2026-09-01", "")
	events, _ := out["events"].([]any)
	if rec.Code != http.StatusOK || len(events) != 1 || events[0].(map[string]any)["audience"] != "contact:tg:@alice" {
		t.Fatalf("GET /journal/search = %d %v, want the contact's event for the owner", rec.Code, out)
	}
	rec, out = serve(t, mux, http.MethodGet, "/journal/search?ids=evt_1,evt_missing", "")
	if events, _ := out["events"].([]any); rec.Code != http.StatusOK || len(events) != 1 {
		t.Fatalf("GET /journal/search?ids = %d %v, want the one known event", rec.Code, out)
	}
	if rec, _ := serve(t, mux, http.MethodGet, "/journal/search?since=yesterday", ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("GET /journal/search with a bad time = %d, want 400", rec.Code)
	}
}

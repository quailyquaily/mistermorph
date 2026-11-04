package daemonruntime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestTopicActivityRouteListsTopicsWithUnfinishedTasks(t *testing.T) {
	store := NewMemoryStore(100)
	now := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	for _, task := range []TaskInfo{
		{ID: "a1", TopicID: "alpha", Status: TaskRunning},
		{ID: "a2", TopicID: "alpha", Status: TaskQueued},
		{ID: "b1", TopicID: "beta", Status: TaskRunning},
		{ID: "b2", TopicID: "beta", Status: TaskPending},
		{ID: "c1", TopicID: "gamma", Status: TaskDone},
		{ID: "c2", TopicID: "gamma", Status: TaskFailed},
		{ID: "d1", TopicID: "delta", Status: TaskCanceled},
		{ID: "x1", Status: TaskRunning},
	} {
		task.CreatedAt = now
		if err := store.Upsert(task); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{AuthToken: "token", TaskTopic: TaskTopicRoutes{TaskReader: store}})

	req := httptest.NewRequest(http.MethodGet, "/topics/activity", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Topics []TopicActivity `json:"topics"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	want := []TopicActivity{
		{ID: "alpha", Status: "running", Running: 2},
		{ID: "beta", Status: "pending", Running: 1, Pending: 1},
	}
	if !reflect.DeepEqual(payload.Topics, want) {
		t.Fatalf("topics = %+v", payload.Topics)
	}

	for _, tc := range []struct {
		method, auth string
		code         int
	}{
		{http.MethodGet, "", http.StatusUnauthorized},
		{http.MethodPost, "Bearer token", http.StatusMethodNotAllowed},
	} {
		req := httptest.NewRequest(tc.method, "/topics/activity", nil)
		if tc.auth != "" {
			req.Header.Set("Authorization", tc.auth)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != tc.code {
			t.Fatalf("%s %q: status %d, want %d", tc.method, tc.auth, rec.Code, tc.code)
		}
	}
	// With no tasks running, the list is empty, not null.
	mux = http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{AuthToken: "token", TaskTopic: TaskTopicRoutes{TaskReader: NewMemoryStore(10)}})
	req = httptest.NewRequest(http.MethodGet, "/topics/activity", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if body := rec.Body.String(); body != "{\"topics\":[]}\n" {
		t.Fatalf("empty body = %q", body)
	}
}

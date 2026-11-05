package daemonruntime

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestTopicActivityRouteListsUnfinishedTasksAndSuccessfulCompletions(t *testing.T) {
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
		{ID: "delta"},
		{ID: "gamma", LatestDoneTaskID: "c1", LatestDoneAt: &now},
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
	// With no tasks, the list is empty, not null.
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

// The runtime's own topics (Awareness, Agent Link agents') count too, though a plain task list
// leaves them out.
func TestTopicActivityIncludesTheRuntimesOwnTopics(t *testing.T) {
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	agentTopic := AgentLinkTopicID("inst_0123456789abcdef0123456789abcdef")
	for _, task := range []TaskInfo{
		{ID: "hb", TopicID: ConsoleAwarenessTopicID, Status: TaskRunning},
		{ID: "al", TopicID: agentTopic, Status: TaskPending},
		{ID: "chat", TopicID: "t1", Status: TaskRunning},
	} {
		task.CreatedAt, task.Task = now, "x"
		if err := store.Upsert(task); err != nil {
			t.Fatal(err)
		}
	}
	got := topicActivity(store)
	want := []TopicActivity{
		{ID: agentTopic, Status: "pending", Pending: 1},
		{ID: ConsoleAwarenessTopicID, Status: "running", Running: 1},
		{ID: "t1", Status: "running", Running: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("activity = %+v", got)
	}
	if plain := store.List(TaskListOptions{Status: TaskRunning, Limit: 10}); len(plain) != 1 || plain[0].ID != "chat" {
		t.Fatalf("plain list = %+v", plain)
	}
}

func TestTopicActivityCompletionAndTaskHistory(t *testing.T) {
	for _, status := range []TaskStatus{TaskDone, TaskFailed, TaskCanceled} {
		t.Run(string(status), func(t *testing.T) {
			store := NewMemoryStore(10)
			now := time.Now().UTC()
			task := TaskInfo{ID: "task", TopicID: "topic", CreatedAt: now, Status: TaskRunning}
			if err := store.Upsert(task); err != nil {
				t.Fatal(err)
			}
			if got := topicActivity(store); len(got) != 1 || got[0].Status != "running" {
				t.Fatalf("running: %+v", got)
			}
			if err := store.Update(task.ID, func(info *TaskInfo) { info.Status = status; info.FinishedAt = &now }); err != nil {
				t.Fatal(err)
			}
			got := topicActivity(store)
			if len(got) != 1 || got[0].Status != "" {
				t.Fatalf("terminal: %+v", got)
			}
			if (got[0].LatestDoneTaskID == task.ID) != (status == TaskDone) {
				t.Fatalf("completion: %+v", got)
			}
			persisted, ok := store.Get(task.ID)
			if !ok || persisted.Status != status || persisted.FinishedAt == nil {
				t.Fatalf("history changed: %+v", persisted)
			}
		})
	}
}

func TestTopicActivityPagesHistoryAndUsesCompletionOrder(t *testing.T) {
	store := NewMemoryStore(1000)
	start := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	// The oldest created task finishes last, beyond the first page of task history.
	finished := start.Add(time.Hour)
	for i := 0; i < 250; i++ {
		task := TaskInfo{ID: fmt.Sprintf("task-%03d", i), TopicID: "topic", CreatedAt: start.Add(time.Duration(i) * time.Second), Status: TaskDone}
		if i == 0 {
			task.FinishedAt = &finished
		}
		if err := store.Upsert(task); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Upsert(TaskInfo{ID: "queued", TopicID: "topic", CreatedAt: start, Status: TaskQueued}); err != nil {
		t.Fatal(err)
	}
	got := topicActivity(store)
	if len(got) != 1 || got[0].LatestDoneTaskID != "task-000" || !got[0].LatestDoneAt.Equal(finished) || got[0].Status != "running" || got[0].Running != 1 {
		t.Fatalf("activity = %+v", got)
	}
}

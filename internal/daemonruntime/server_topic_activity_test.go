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

// Running TODO runs count, whether their schedule or Run now started them: not queued or finished
// ones, not other tasks, and not by the topic ID alone.
func TestTopicActivityCountsRunningTodoRuns(t *testing.T) {
	scheduled := TaskTrigger{Source: "console", Event: CronRunTriggerEvent, Ref: CronRunTriggerRefSchedule}
	manual := TaskTrigger{Source: "console", Event: CronRunTriggerEvent, Ref: CronRunTriggerRefManual}
	chat := TaskTrigger{Source: "ui", Event: "chat_submit"}
	heartbeat := TaskTrigger{Source: "console", Event: "awareness_heartbeat"}
	type task struct {
		id, topic string
		status    TaskStatus
		trigger   TaskTrigger
	}
	cron := func(name string) string { return CronTopicID(name) }
	for _, tc := range []struct {
		name  string
		tasks []task
		want  map[string]int
	}{
		{"none", []task{
			{"q", cron("a"), TaskQueued, scheduled},
			{"p", cron("a"), TaskPending, scheduled},
			{"d", cron("a"), TaskDone, scheduled},
			{"f", cron("a"), TaskFailed, scheduled},
			{"c", cron("a"), TaskCanceled, scheduled},
			{"mq", cron("a"), TaskQueued, manual},
			{"chat", "t1", TaskRunning, chat},
			{"hb", ConsoleAwarenessTopicID, TaskRunning, heartbeat},
			{"untriggered", cron("b"), TaskRunning, TaskTrigger{}},
		}, map[string]int{}},
		{"one", []task{
			{"s", cron("a"), TaskRunning, scheduled},
			{"q", cron("a"), TaskQueued, scheduled},
		}, map[string]int{cron("a"): 1}},
		{"run now", []task{
			{"m", cron("a"), TaskRunning, manual},
		}, map[string]int{cron("a"): 1}},
		{"several topics and a mixed one", []task{
			{"s1", cron("a"), TaskRunning, scheduled},
			{"m1", cron("a"), TaskRunning, manual},
			{"s2", cron("b"), TaskRunning, scheduled},
			{"s3", cron("b"), TaskRunning, scheduled},
			{"chat", "t1", TaskRunning, chat},
		}, map[string]int{cron("a"): 2, cron("b"): 2}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stores := map[string]interface {
				TaskReader
				RecordTaskUpsert(TaskInfo, TaskTrigger) error
			}{}
			console, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			file, err := NewFileTaskStore(FileTaskStoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			stores["console"], stores["file"] = console, file
			for name, store := range stores {
				now := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
				for _, item := range tc.tasks {
					info := TaskInfo{ID: item.id, TopicID: item.topic, Status: item.status, Task: "x", CreatedAt: now}
					if err := store.RecordTaskUpsert(info, item.trigger); err != nil {
						t.Fatal(err)
					}
				}
				got := map[string]int{}
				for _, item := range topicActivity(store) {
					if item.CronRunning > 0 {
						got[item.ID] = item.CronRunning
					}
				}
				if !reflect.DeepEqual(got, tc.want) {
					t.Fatalf("%s: cron running = %v, want %v", name, got, tc.want)
				}
			}
		})
	}
}

// The old status and counts stay as they were, and finishing the last running TODO run clears the
// count, whatever the run ended as.
func TestTopicActivityCronRunningKeepsStatusAndClearsWhenRunsEnd(t *testing.T) {
	for _, status := range []TaskStatus{TaskDone, TaskFailed, TaskCanceled} {
		t.Run(string(status), func(t *testing.T) {
			store, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
			trigger := TaskTrigger{Source: "console", Event: CronRunTriggerEvent, Ref: CronRunTriggerRefSchedule}
			topic := CronTopicID("a")
			for _, id := range []string{"s1", "s2"} {
				if err := store.RecordTaskUpsert(TaskInfo{ID: id, TopicID: topic, Status: TaskRunning, Task: "x", CreatedAt: now}, trigger); err != nil {
					t.Fatal(err)
				}
			}
			if err := store.RecordTaskUpsert(TaskInfo{ID: "q", TopicID: topic, Status: TaskQueued, Task: "x", CreatedAt: now}, trigger); err != nil {
				t.Fatal(err)
			}
			want := []TopicActivity{{ID: topic, Status: "running", Running: 3, CronRunning: 2}}
			if got := topicActivity(store); !reflect.DeepEqual(got, want) {
				t.Fatalf("running = %+v", got)
			}
			finish := func(id string) {
				t.Helper()
				if err := store.RecordTaskUpdate(id, TaskTrigger{}, func(info *TaskInfo) { info.Status = status; info.FinishedAt = &now }); err != nil {
					t.Fatal(err)
				}
			}
			finish("s1")
			if got := topicActivity(store); len(got) != 1 || got[0].CronRunning != 1 || got[0].Running != 2 {
				t.Fatalf("one of two finished: %+v", got)
			}
			finish("s2")
			if got := topicActivity(store); len(got) != 1 || got[0].CronRunning != 0 || got[0].Running != 1 || got[0].Status != "running" {
				t.Fatalf("last finished: %+v", got)
			}
			// The queued run starting counts once it runs.
			if err := store.RecordTaskUpdate("q", TaskTrigger{}, func(info *TaskInfo) { info.Status = TaskRunning }); err != nil {
				t.Fatal(err)
			}
			if got := topicActivity(store); len(got) != 1 || got[0].CronRunning != 1 {
				t.Fatalf("queued started: %+v", got)
			}
		})
	}
}

// Running runs beyond the first page of task history still count, and a reader that keeps no
// triggers reports none.
func TestTopicActivityCronRunningPagesHistory(t *testing.T) {
	store, err := NewFileTaskStore(FileTaskStoreOptions{MaxItems: 1000})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	trigger := TaskTrigger{Source: "console", Event: CronRunTriggerEvent, Ref: CronRunTriggerRefSchedule}
	if err := store.RecordTaskUpsert(TaskInfo{ID: "oldest", TopicID: CronTopicID("old"), Status: TaskRunning, Task: "x", CreatedAt: start}, trigger); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 250; i++ {
		info := TaskInfo{ID: fmt.Sprintf("task-%03d", i), TopicID: "topic", Status: TaskDone, Task: "x", CreatedAt: start.Add(time.Duration(i) * time.Second)}
		if err := store.RecordTaskUpsert(info, TaskTrigger{Source: "ui", Event: "chat_submit"}); err != nil {
			t.Fatal(err)
		}
	}
	var got int
	for _, item := range topicActivity(store) {
		got += item.CronRunning
	}
	if got != 1 {
		t.Fatalf("cron running = %d", got)
	}

	memory := NewMemoryStore(10)
	if err := memory.Upsert(TaskInfo{ID: "s", TopicID: CronTopicID("a"), Status: TaskRunning, CreatedAt: start}); err != nil {
		t.Fatal(err)
	}
	if activity := topicActivity(memory); len(activity) != 1 || activity[0].CronRunning != 0 || activity[0].Running != 1 {
		t.Fatalf("memory = %+v", activity)
	}
}

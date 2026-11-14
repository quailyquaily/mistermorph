package daemonruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type runningTaskSeed struct {
	status  TaskStatus
	trigger TaskTrigger
	steer   bool
}

var (
	webChat    = TaskTrigger{Source: "ui", Event: "chat_submit", Ref: "web/console/chat"}
	webDefault = TaskTrigger{Source: "ui", Event: "chat_submit", Ref: "web/console"}
	cliRemote  = TaskTrigger{Source: "ui", Event: "chat_submit", Ref: "cli/chat"}
	cliLocal   = TaskTrigger{Source: "chat", Event: "chat_submit"}
	awareness  = TaskTrigger{Source: "console", Event: "awareness_cron"}
	linkReply  = TaskTrigger{Source: "agentlink", Event: "reply"}
	telegramIn = TaskTrigger{Source: "telegram", Event: "message"}
	heartbeat  = TaskTrigger{Source: "system", Event: "heartbeat"}
)

func seedRunningTasks(t *testing.T, store interface {
	UpsertWithTrigger(TaskInfo, TaskTrigger, string) error
}, seeds []runningTaskSeed) {
	t.Helper()
	now := time.Now().UTC()
	for i, seed := range seeds {
		info := TaskInfo{ID: fmt.Sprintf("task-%d", i), TopicID: fmt.Sprintf("topic-%d", i), Status: seed.status, CreatedAt: now.Add(time.Duration(i) * time.Second)}
		if seed.steer {
			// A steered message rides on the task before it.
			info.SteerTargetTaskID = fmt.Sprintf("task-%d", i-1)
			info.TopicID = fmt.Sprintf("topic-%d", i-1)
		}
		if err := store.UpsertWithTrigger(info, seed.trigger, ""); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
}

type fileTaskStoreWriter struct{ *FileTaskStore }

func (s fileTaskStoreWriter) UpsertWithTrigger(info TaskInfo, trigger TaskTrigger, _ string) error {
	return s.RecordTaskUpsert(info, trigger)
}

func TestConsoleRunningTaskCounts(t *testing.T) {
	tests := []struct {
		name  string
		seeds []runningTaskSeed
		want  map[string]int
	}{
		{name: "none", want: map[string]int{"console": 0, "cli": 0}},
		{name: "one console", seeds: []runningTaskSeed{{status: TaskRunning, trigger: webChat}}, want: map[string]int{"console": 1, "cli": 0}},
		{
			name: "console and cli, each once",
			seeds: []runningTaskSeed{
				{status: TaskRunning, trigger: webChat},
				{status: TaskRunning, trigger: webDefault},
				{status: TaskRunning, trigger: cliRemote},
				{status: TaskRunning, trigger: cliLocal},
				{status: TaskRunning, trigger: cliLocal},
			},
			want: map[string]int{"console": 2, "cli": 3},
		},
		{
			name: "queued, pending and finished tasks are not running",
			seeds: []runningTaskSeed{
				{status: TaskQueued, trigger: webChat},
				{status: TaskPending, trigger: webChat},
				{status: TaskDone, trigger: webChat},
				{status: TaskFailed, trigger: cliRemote},
				{status: TaskCanceled, trigger: cliRemote},
			},
			want: map[string]int{"console": 0, "cli": 0},
		},
		{
			name: "a steered message is part of its task's run",
			seeds: []runningTaskSeed{
				{status: TaskRunning, trigger: webChat},
				{status: TaskRunning, trigger: webChat, steer: true},
			},
			want: map[string]int{"console": 1, "cli": 0},
		},
		{
			name: "background work counts under no entry",
			seeds: []runningTaskSeed{
				{status: TaskRunning, trigger: awareness},
				{status: TaskRunning, trigger: linkReply},
				{status: TaskRunning},
			},
			want: map[string]int{"console": 0, "cli": 0},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			seedRunningTasks(t, store, tc.seeds)
			got, ok := CountRunningTasks(store, ConsoleRunningTaskEntry, RunningTasksConsole, RunningTasksCLI)
			if !ok {
				t.Fatal("CountRunningTasks() ok = false, want true")
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("counts = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestChannelRunningTaskCounts(t *testing.T) {
	tests := []struct {
		name  string
		seeds []runningTaskSeed
		want  int
	}{
		{name: "none", want: 0},
		{name: "one", seeds: []runningTaskSeed{{status: TaskRunning, trigger: telegramIn}}, want: 1},
		{
			name: "several, with the channel's own heartbeat",
			seeds: []runningTaskSeed{
				{status: TaskRunning, trigger: telegramIn},
				{status: TaskRunning, trigger: telegramIn},
				{status: TaskRunning, trigger: heartbeat},
			},
			want: 3,
		},
		{
			name: "queued and finished tasks are not running",
			seeds: []runningTaskSeed{
				{status: TaskQueued, trigger: telegramIn},
				{status: TaskPending, trigger: telegramIn},
				{status: TaskDone, trigger: telegramIn},
				{status: TaskFailed, trigger: telegramIn},
				{status: TaskCanceled, trigger: telegramIn},
				{status: TaskRunning, trigger: telegramIn},
			},
			want: 1,
		},
		{
			name:  "an Agent Link message beside the channel is not the channel's",
			seeds: []runningTaskSeed{{status: TaskRunning, trigger: TaskTrigger{Source: "agentlink", Event: "message"}}},
			want:  0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			view, err := NewTaskViewForTarget("telegram", 100, TaskViewConfig{JournalDir: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			seedRunningTasks(t, fileTaskStoreWriter{view.(*FileTaskStore)}, tc.seeds)
			got, ok := CountRunningTasks(view, ChannelRunningTaskEntry("telegram"), "telegram")
			if !ok {
				t.Fatal("CountRunningTasks() ok = false, want true")
			}
			if want := map[string]int{"telegram": tc.want}; !reflect.DeepEqual(got, want) {
				t.Fatalf("counts = %v, want %v", got, want)
			}
		})
	}
}

func TestRunningTaskCountsFollowStartsAndFinishes(t *testing.T) {
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	count := func() int {
		got, ok := CountRunningTasks(store, ConsoleRunningTaskEntry, RunningTasksConsole)
		if !ok {
			t.Fatal("CountRunningTasks() ok = false")
		}
		return got[RunningTasksConsole]
	}
	now := time.Now().UTC()
	if err := store.UpsertWithTrigger(TaskInfo{ID: "a", TopicID: "t", Status: TaskQueued, CreatedAt: now}, webChat, ""); err != nil {
		t.Fatal(err)
	}
	if got := count(); got != 0 {
		t.Fatalf("queued: %d, want 0", got)
	}
	for _, step := range []struct {
		status TaskStatus
		want   int
	}{{TaskRunning, 1}, {TaskPending, 0}, {TaskRunning, 1}, {TaskDone, 0}} {
		if err := store.Update("a", func(info *TaskInfo) { info.Status = step.status }); err != nil {
			t.Fatal(err)
		}
		if got := count(); got != step.want {
			t.Fatalf("%s: %d, want %d", step.status, got, step.want)
		}
	}
}

func TestConsoleRunningTaskCountsSeeLiveChatOnly(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: filepath.Join(root, "console"), JournalDir: filepath.Join(root, "journal"), Persist: true, SkipRecovery: true}
	chat, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	opts.SkipRecovery = false
	web, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	owner, release, err := chat.AcquireChatSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The chat command's process writes its task after the Console opened the store.
	if err := chat.UpsertWithTrigger(TaskInfo{ID: "chat-running", TopicID: "shared", Status: TaskRunning, CreatedAt: time.Now().UTC()}, TaskTrigger{Source: "chat", Ref: owner}, "shared"); err != nil {
		release()
		t.Fatal(err)
	}
	got, ok := CountRunningTasks(web, ConsoleRunningTaskEntry, RunningTasksConsole, RunningTasksCLI)
	if !ok || got[RunningTasksCLI] != 1 || got[RunningTasksConsole] != 0 {
		release()
		t.Fatalf("live chat: counts = %v (ok %v), want cli 1, console 0", got, ok)
	}
	// Its process is gone: its task ended with it.
	release()
	got, ok = CountRunningTasks(web, ConsoleRunningTaskEntry, RunningTasksConsole, RunningTasksCLI)
	if !ok || got[RunningTasksCLI] != 0 {
		t.Fatalf("exited chat: counts = %v (ok %v), want cli 0", got, ok)
	}
}

type plainTaskReader struct{}

func (plainTaskReader) List(TaskListOptions) []TaskInfo { return nil }
func (plainTaskReader) Get(string) (*TaskInfo, bool)    { return nil, false }

func TestCountRunningTasksUnknownWithoutCounter(t *testing.T) {
	if got, ok := CountRunningTasks(plainTaskReader{}, ConsoleRunningTaskEntry, RunningTasksConsole); ok || got != nil {
		t.Fatalf("CountRunningTasks(plain reader) = %v, %v; want unknown", got, ok)
	}
	if got, ok := CountRunningTasks(nil, ConsoleRunningTaskEntry, RunningTasksConsole); ok || got != nil {
		t.Fatalf("CountRunningTasks(nil) = %v, %v; want unknown", got, ok)
	}
}

func TestOverviewRunningTasks(t *testing.T) {
	telegramStore := func(t *testing.T, running int) TaskReader {
		view, err := NewTaskViewForTarget("telegram", 100, TaskViewConfig{JournalDir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		seeds := []runningTaskSeed{{status: TaskDone, trigger: telegramIn}, {status: TaskRunning, trigger: linkReply}}
		for i := 0; i < running; i++ {
			seeds = append(seeds, runningTaskSeed{status: TaskRunning, trigger: telegramIn})
		}
		seedRunningTasks(t, fileTaskStoreWriter{view.(*FileTaskStore)}, seeds)
		return view
	}
	tests := []struct {
		name     string
		mode     string
		reader   func(*testing.T) TaskReader
		overview OverviewFunc
		want     map[string]any
	}{
		{name: "a channel runtime counts its own", mode: "telegram", reader: func(t *testing.T) TaskReader { return telegramStore(t, 2) }, want: map[string]any{"telegram": float64(2)}},
		{name: "a known zero", mode: "telegram", reader: func(t *testing.T) TaskReader { return telegramStore(t, 0) }, want: map[string]any{"telegram": float64(0)}},
		{name: "a store that cannot count leaves it unknown", mode: "telegram", reader: func(*testing.T) TaskReader { return plainTaskReader{} }},
		{name: "no task store, unknown", mode: "telegram"},
		{name: "not a channel", mode: "serve", reader: func(t *testing.T) TaskReader { return telegramStore(t, 1) }},
		{
			name:   "the runtime's own counts stand",
			mode:   "console",
			reader: func(t *testing.T) TaskReader { return telegramStore(t, 1) },
			overview: func(context.Context) (map[string]any, error) {
				return map[string]any{"running_tasks": map[string]any{"console": 1, "cli": 0}}, nil
			},
			want: map[string]any{"console": float64(1), "cli": float64(0)},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts := RoutesOptions{Mode: tc.mode, AuthToken: "token", Overview: tc.overview}
			if tc.reader != nil {
				opts.TaskTopic.TaskReader = tc.reader(t)
			}
			mux := http.NewServeMux()
			RegisterRoutes(mux, opts)
			req := httptest.NewRequest(http.MethodGet, "/overview", nil)
			req.Header.Set("Authorization", "Bearer token")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
			}
			var payload map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			got, present := payload["running_tasks"]
			if tc.want == nil {
				if present {
					t.Fatalf("running_tasks = %v, want absent (unknown)", got)
				}
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("running_tasks = %#v, want %#v", got, tc.want)
			}
		})
	}
}

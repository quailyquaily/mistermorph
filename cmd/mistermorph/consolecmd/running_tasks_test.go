package consolecmd

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/spf13/viper"
)

func newRunningTasksTestRuntime(t *testing.T) *consoleLocalRuntime {
	t.Helper()
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	reader := viper.New()
	reader.Set("file_state_dir", t.TempDir())
	return &consoleLocalRuntime{store: store, generation: &consoleLocalRuntimeGeneration{reader: reader}}
}

func newChannelTaskStore(t *testing.T, kind string, running int) daemonruntime.TaskView {
	t.Helper()
	view, err := daemonruntime.NewTaskViewForTarget(kind, 100, daemonruntime.TaskViewConfig{JournalDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := 0; i < running; i++ {
		if err := view.Upsert(daemonruntime.TaskInfo{ID: kind + "-" + string(rune('a'+i)), Status: daemonruntime.TaskRunning, CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err := view.Upsert(daemonruntime.TaskInfo{ID: kind + "-done", Status: daemonruntime.TaskDone, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	return view
}

func TestConsoleOverviewRunningTasks(t *testing.T) {
	rt := newRunningTasksTestRuntime(t)
	now := time.Now().UTC()
	for _, seed := range []struct {
		id      string
		status  daemonruntime.TaskStatus
		trigger daemonruntime.TaskTrigger
	}{
		{"web-1", daemonruntime.TaskRunning, daemonruntime.TaskTrigger{Source: "ui", Ref: consoleChatTriggerRef}},
		{"web-2", daemonruntime.TaskQueued, daemonruntime.TaskTrigger{Source: "ui", Ref: consoleChatTriggerRef}},
		{"cli-1", daemonruntime.TaskRunning, daemonruntime.TaskTrigger{Source: "ui", Ref: consoleCLIChatTriggerRef}},
		{"cron-1", daemonruntime.TaskRunning, daemonruntime.TaskTrigger{Source: "console", Event: "awareness_cron"}},
	} {
		if err := rt.store.UpsertWithTrigger(daemonruntime.TaskInfo{ID: seed.id, TopicID: "topic-" + seed.id, Status: seed.status, CreatedAt: now}, seed.trigger, ""); err != nil {
			t.Fatal(err)
		}
	}
	// Telegram runs with two tasks; Slack runs with a store that is not known; Lark's store is
	// there but Lark has stopped; Discord runs and is idle.
	rt.SetManagedRuntimeTasks("telegram", newChannelTaskStore(t, "telegram", 2))
	rt.SetManagedRuntimeRunning("telegram", true)
	rt.SetManagedRuntimeRunning("slack", true)
	rt.SetManagedRuntimeTasks("lark", newChannelTaskStore(t, "lark", 1))
	rt.SetManagedRuntimeRunning("lark", true)
	rt.SetManagedRuntimeRunning("lark", false)
	rt.SetManagedRuntimeTasks("discord", newChannelTaskStore(t, "discord", 0))
	rt.SetManagedRuntimeRunning("discord", true)

	payload, err := rt.routesOptions("token").Overview(context.Background())
	if err != nil {
		t.Fatalf("Overview() error = %v", err)
	}
	want := map[string]any{"console": 1, "cli": 1, "telegram": 2, "discord": 0}
	if got := payload["running_tasks"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("running_tasks = %#v, want %#v", got, want)
	}
}

func TestManagedRuntimeSupervisorHandsChannelTasksToOverview(t *testing.T) {
	rt := newRunningTasksTestRuntime(t)
	tasks := newChannelTaskStore(t, "telegram", 1)
	exit := make(chan struct{})
	supervisor := newManagedRuntimeSupervisor(rt, false, false)
	supervisor.pendingPrepared = &managedRuntimePrepared{
		reader: viper.New(),
		kinds:  []string{"telegram"},
		children: []managedPreparedRuntime{{
			kind:  "telegram",
			tasks: tasks,
			run: func(ctx context.Context) error {
				select {
				case <-ctx.Done():
				case <-exit:
				}
				return nil
			},
		}},
	}
	if err := supervisor.Start(context.Background(), nil); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer supervisor.Close()
	if got := rt.runningTaskCounts()["telegram"]; got != 1 {
		t.Fatalf("running telegram = %#v, want 1", got)
	}
	// The channel stops: its count is no longer taken.
	close(exit)
	deadline := time.Now().Add(2 * time.Second)
	for rt.isManagedRuntimeRunning("telegram") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if _, ok := rt.runningTaskCounts()["telegram"]; ok {
		t.Fatalf("stopped telegram still counted: %#v", rt.runningTaskCounts())
	}
}

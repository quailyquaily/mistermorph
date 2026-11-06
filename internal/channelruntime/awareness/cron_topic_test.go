package awareness

import (
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/awarenessutil"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

type titledTaskStore struct {
	*daemonruntime.MemoryStore
	titles []string
}

func (s *titledTaskStore) UpsertWithTrigger(info daemonruntime.TaskInfo, _ daemonruntime.TaskTrigger, title string) error {
	s.titles = append(s.titles, title)
	return s.MemoryStore.Upsert(info)
}

func TestRecordAwarenessTaskStartUsesTheTodoItemsTopic(t *testing.T) {
	now := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	store := &titledTaskStore{MemoryStore: daemonruntime.NewMemoryStore(10)}
	opts := awarenessTaskOptions{
		TaskRunID: "cron:1", TaskStore: store,
		TopicID: daemonruntime.CronTopicID("task-4"), TopicTitle: cronTopicTitle(cronstore.Task{ID: "task-4", Title: " Morph build "}),
	}
	if err := recordAwarenessTaskStart(opts, "Run the build.", now); err != nil {
		t.Fatal(err)
	}
	got, ok := store.Get("cron:1")
	if !ok || got.TopicID != "_cron_task-4" || got.Status != daemonruntime.TaskRunning {
		t.Fatalf("task = %+v", got)
	}
	if len(store.titles) != 1 || store.titles[0] != "Morph build" {
		t.Fatalf("titles = %q", store.titles)
	}

	// A heartbeat run stays in Awareness, and a store without topics records the topic ID only.
	plain := daemonruntime.NewMemoryStore(10)
	if err := recordAwarenessTaskStart(awarenessTaskOptions{TaskRunID: "hb:1", TaskStore: plain}, "beat", now); err != nil {
		t.Fatal(err)
	}
	if got, _ := plain.Get("hb:1"); got.TopicID != daemonruntime.ConsoleAwarenessTopicID {
		t.Fatalf("heartbeat topic = %q", got.TopicID)
	}
	opts.TaskStore, opts.TaskRunID = plain, "cron:2"
	if err := recordAwarenessTaskStart(opts, "Run the build.", now); err != nil {
		t.Fatal(err)
	}
	if got, _ := plain.Get("cron:2"); got.TopicID != "_cron_task-4" {
		t.Fatalf("cron topic = %q", got.TopicID)
	}
	if got := cronTopicTitle(cronstore.Task{ID: "x"}); got != cronstore.DefaultTaskTitle {
		t.Fatalf("untitled = %q", got)
	}
}

// A TODO item's run records whether its schedule fired it, from start to finish, for the
// Console to tell such runs from the ones a person asked for.
func TestAwarenessTaskTriggerTellsScheduledFromManualRuns(t *testing.T) {
	now := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name      string
		behavior  awarenessutil.Behavior
		manual    bool
		wantRef   string
		scheduled bool
	}{
		{"scheduled cron", awarenessutil.BehaviorCron, false, daemonruntime.CronRunTriggerRefSchedule, true},
		{"manual cron", awarenessutil.BehaviorCron, true, daemonruntime.CronRunTriggerRefManual, false},
		{"heartbeat", awarenessutil.BehaviorHeartbeat, false, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			opts := awarenessTaskOptions{
				Behavior: tc.behavior, TaskRunID: "run:1", TaskStore: store, CronManual: tc.manual,
				TopicID: daemonruntime.CronTopicID("task-4"), TopicTitle: "Morph build",
			}
			if err := recordAwarenessTaskStart(opts, "Run the build.", now); err != nil {
				t.Fatal(err)
			}
			trigger, ok := store.GetTrigger("run:1")
			if !ok || trigger.Event != "awareness_"+string(tc.behavior) || trigger.Ref != tc.wantRef || trigger.TraceID != "run:1" {
				t.Fatalf("trigger = %+v, %v", trigger, ok)
			}
			if got := daemonruntime.IsCronRunTrigger(trigger); got != (tc.behavior == awarenessutil.BehaviorCron) {
				t.Fatalf("IsCronRunTrigger = %v", got)
			}
			if got := daemonruntime.IsScheduledCronRunTrigger(trigger); got != tc.scheduled {
				t.Fatalf("IsScheduledCronRunTrigger = %v", got)
			}
			if err := recordAwarenessTaskFinish(opts, "done", nil, nil, now.Add(time.Minute)); err != nil {
				t.Fatal(err)
			}
			if finished, ok := store.GetTrigger("run:1"); !ok || finished != trigger {
				t.Fatalf("finished trigger = %+v, %v; want %+v", finished, ok, trigger)
			}
		})
	}
}

package consolecmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/solo"
	"github.com/quailyquaily/mistermorph/llm"
)

var soloThreadTrigger = daemonruntime.TaskTrigger{Source: "ui", Event: daemonruntime.SoloThreadTriggerEvent, Ref: consoleChatTriggerRef}

func intPtr(n int) *int { return &n }

// soloWorkersTool stands in for a thread task's work: it starts a subagent and a coder as the
// engine reports them, with everything a real worker carries (what it was asked, its output, its
// result, its processes), then ends the subagent and fails the coder.
type soloWorkersTool struct{}

func (soloWorkersTool) Name() string            { return "work" }
func (soloWorkersTool) Description() string     { return "test thread workers" }
func (soloWorkersTool) ParameterSchema() string { return `{}` }
func (soloWorkersTool) Execute(ctx context.Context, _ map[string]any) (string, error) {
	for _, event := range soloWorkerEvents() {
		agent.EmitEvent(ctx, nil, event)
	}
	return "worked", nil
}

func soloWorkerEvents() []agent.Event {
	ada := &agent.WorkerMetadata{ID: "worker-1", Name: "Ada", NameSet: "scientists", NameIndex: intPtr(4), AvatarIndex: intPtr(2)}
	milo := &agent.WorkerMetadata{ID: "worker-2", Name: "Milo", NameSet: "scientists", NameIndex: intPtr(9), AvatarIndex: intPtr(5),
		Processes: []agent.WorkerProcess{{PID: 424242, Program: "codex", ActivityID: "coder-1"}}}
	events := []agent.Event{
		{Kind: agent.EventKindToolStart, ActivityID: "spawn-1", ToolName: "spawn", Status: "running", Worker: ada, Args: map[string]any{"task": "SECRET-ASK research"}},
		{Kind: agent.EventKindToolStart, ActivityID: "coder-1", ToolName: "coder", Status: "running", Worker: milo, Stream: "codex", Args: map[string]any{"task": "SECRET-ASK code"}},
		{Kind: agent.EventKindWorkerProcess, ActivityID: "coder-1", Worker: milo},
	}
	// What a worker prints changes the activity each time, and never who works on the task.
	for i := 0; i < 6; i++ {
		events = append(events, agent.Event{Kind: agent.EventKindToolOutput, ActivityID: "coder-1", ToolName: "coder", Worker: milo, Stream: "codex", Text: fmt.Sprintf("SECRET-OUTPUT line %d\n", i)})
	}
	return append(events,
		agent.Event{Kind: agent.EventKindToolDone, ActivityID: "spawn-1", ToolName: "spawn", Status: "done", Worker: ada, Text: `{"status":"done","output":"SECRET-RESULT"}`},
		// The same completion again: one worker still.
		agent.Event{Kind: agent.EventKindToolDone, ActivityID: "spawn-1", ToolName: "spawn", Status: "done", Worker: ada, Text: `{"status":"done","output":"SECRET-RESULT"}`},
		agent.Event{Kind: agent.EventKindToolDone, ActivityID: "coder-1", ToolName: "coder", Status: "failed", Worker: milo, Stream: "codex", Error: "SECRET-ERROR exit 1"},
	)
}

func soloCardOf(t *testing.T, rt *consoleLocalRuntime, taskID string) daemonruntime.SoloThread {
	t.Helper()
	card, ok := rt.store.Get(daemonruntime.SoloThreadCardID(taskID))
	if !ok || card == nil {
		t.Fatalf("no card of %s", taskID)
	}
	rec, ok := solo.ThreadOf(*card)
	if !ok {
		t.Fatalf("card of %s has no thread: %+v", taskID, card)
	}
	return rec
}

func soloParticipantLine(list []daemonruntime.SoloParticipant) string {
	parts := make([]string, 0, len(list))
	for _, p := range list {
		parts = append(parts, p.ID+"/"+p.Name+"/"+p.Kind+"/"+p.Status)
	}
	return strings.Join(parts, " ")
}

func newSoloParticipantRuntime(t *testing.T, steps []consoleProgressPersistenceLLMStep) (*consoleLocalRuntime, consoleLocalTaskJob, string) {
	t.Helper()
	rt, job, _ := newConsoleProgressPersistenceRuntime(t, steps, "work", false)
	if _, err := rt.store.EnsureSoloTopic(); err != nil {
		t.Fatal(err)
	}
	thread, err := rt.store.CreateThreadTopic("Migrate", daemonruntime.ConsoleSoloTopicID)
	if err != nil {
		t.Fatal(err)
	}
	return rt, job, thread.ID
}

func startSoloParticipantTask(t *testing.T, rt *consoleLocalRuntime, topicID string, taskID string) {
	t.Helper()
	if err := rt.store.UpsertWithTrigger(daemonruntime.TaskInfo{ID: taskID, TopicID: topicID, Task: "migrate", Status: daemonruntime.TaskRunning}, soloThreadTrigger, ""); err != nil {
		t.Fatal(err)
	}
	if err := rt.writeSoloThreadCard(daemonruntime.SoloThread{Kind: daemonruntime.SoloRecordCard, TopicID: topicID, TaskID: taskID, Title: "Migrate", Workspace: "~/db", State: daemonruntime.SoloThreadRunning}); err != nil {
		t.Fatal(err)
	}
}

// A thread task's real run: the subagent and the coder it starts reach its card while it runs,
// the card is written only when who works on the task (or how one is doing) changed, and its end
// brings a summary that agrees with the card. Nothing but identities reaches either record.
func TestSoloThreadCardFollowsItsTasksWorkers(t *testing.T) {
	rt, job, _ := newConsoleProgressPersistenceRuntime(t, []consoleProgressPersistenceLLMStep{
		{result: consoleProgressToolCall("work")},
		{result: llm.Result{Text: `{"type":"final","output":"done"}`}},
	}, "work", false)
	if _, err := rt.store.EnsureSoloTopic(); err != nil {
		t.Fatal(err)
	}
	if err := job.Generation.commonDeps.Registry().Replace(soloWorkersTool{}); err != nil {
		t.Fatal(err)
	}
	job.Trigger = soloThreadTrigger
	if err := rt.writeSoloThreadCard(daemonruntime.SoloThread{Kind: daemonruntime.SoloRecordCard, TopicID: job.TopicID, TaskID: job.TaskID, Title: "Migrate", State: daemonruntime.SoloThreadRunning}); err != nil {
		t.Fatal(err)
	}
	rt.handleTaskJob(context.Background(), job.ConversationKey, job)

	// Before anything looks at the task's end, the card already has both workers as they ended.
	live := soloCardOf(t, rt, job.TaskID)
	if got := soloParticipantLine(live.Participants); got != "worker-1/Ada/subagent/done worker-2/Milo/coder/failed" || live.ParticipantsOmitted != 0 {
		t.Fatalf("card after the run = %q, omitted %d", got, live.ParticipantsOmitted)
	}
	ada := live.Participants[0]
	if ada.NameSet != "scientists" || ada.NameIndex == nil || *ada.NameIndex != 4 || ada.AvatarIndex == nil || *ada.AvatarIndex != 2 {
		t.Fatalf("identity = %+v", ada)
	}
	if live.State != daemonruntime.SoloThreadRunning {
		t.Fatalf("card state = %s before its sync", live.State)
	}

	rt.syncSoloThread(job.TaskID)
	card := soloCardOf(t, rt, job.TaskID)
	summaryTask, ok := rt.store.Get(daemonruntime.SoloThreadSummaryID(job.TaskID))
	if !ok {
		t.Fatal("no summary")
	}
	summary, _ := solo.ThreadOf(*summaryTask)
	for name, rec := range map[string]daemonruntime.SoloThread{"card": card, "summary": summary} {
		// The coder that failed stays failed in a task that is done.
		if rec.State != daemonruntime.SoloThreadDone || soloParticipantLine(rec.Participants) != "worker-1/Ada/subagent/done worker-2/Milo/coder/failed" {
			t.Fatalf("%s = %s %q", name, rec.State, soloParticipantLine(rec.Participants))
		}
	}
	cardTask, _ := rt.store.Get(daemonruntime.SoloThreadCardID(job.TaskID))
	for name, task := range map[string]*daemonruntime.TaskInfo{"card": cardTask, "summary": summaryTask} {
		raw, err := json.Marshal(task)
		if err != nil {
			t.Fatal(err)
		}
		for _, leak := range []string{"SECRET", "424242", "pid", "processes", "codex", "activity"} {
			if strings.Contains(string(raw), leak) {
				t.Fatalf("%s record carries %q: %s", name, leak, raw)
			}
		}
	}
}

// The card's durable writes while its task runs: one for each change of who works on it or how
// they are doing, none for what they print, none for an event that repeats what the card has.
func TestSoloParticipantFeedWritesOnlyChanges(t *testing.T) {
	rt, job, journal := newConsoleProgressPersistenceRuntime(t, nil, "work", false)
	if _, err := rt.store.EnsureSoloTopic(); err != nil {
		t.Fatal(err)
	}
	job.Trigger = soloThreadTrigger
	if err := rt.writeSoloThreadCard(daemonruntime.SoloThread{Kind: daemonruntime.SoloRecordCard, TopicID: job.TopicID, TaskID: job.TaskID, Title: "Migrate", State: daemonruntime.SoloThreadRunning}); err != nil {
		t.Fatal(err)
	}
	cardID := daemonruntime.SoloThreadCardID(job.TaskID)
	// The card's own first write is an upsert; every later one is an update.
	writes := func() int { return len(consoleProgressTaskUpdates(t, journal, cardID)) }
	if writes() != 0 {
		t.Fatalf("card writes at the start = %d", writes())
	}
	feed := rt.newSoloParticipantFeed(job)
	if feed == nil {
		t.Fatal("a thread task has no participant feed")
	}
	var progress *consoleActivityProgress
	var seen []string
	apply := func(event agent.Event) {
		next, changed := updateConsoleActivityProgress(progress, event)
		progress = next
		if changed {
			feed.activityUpdated(progress)
		}
		seen = append(seen, fmt.Sprintf("%s:%d", event.Kind, writes()))
	}
	// Activity without workers writes nothing.
	apply(agent.Event{Kind: agent.EventKindToolStart, ActivityID: "bash-1", ToolName: "bash", Status: "running", Args: map[string]any{"cmd": "ls"}})
	apply(agent.Event{Kind: agent.EventKindToolDone, ActivityID: "bash-1", ToolName: "bash", Status: "done", Text: "files"})
	if writes() != 0 {
		t.Fatalf("card writes after a call without workers = %d", writes())
	}
	for _, event := range soloWorkerEvents() {
		apply(event)
	}
	// Ada starts, Milo starts, Ada is done, Milo failed: four changes, four writes.
	if writes() != 4 {
		t.Fatalf("card writes = %d, want 4 (%v)", writes(), seen)
	}
	rec := soloCardOf(t, rt, job.TaskID)
	if got := soloParticipantLine(rec.Participants); got != "worker-1/Ada/subagent/done worker-2/Milo/coder/failed" {
		t.Fatalf("card = %q", got)
	}
	// The same activity again, and a reading that changes nothing on the card, write nothing.
	feed.activityUpdated(progress)
	rt.writeSoloThreadParticipants(job.TaskID, func() ([]daemonruntime.SoloParticipant, int) { return rec.Participants, 0 })
	rt.syncSoloThread("no-such-task")
	if writes() != 4 {
		t.Fatalf("card writes after unchanged readings = %d", writes())
	}

	// A task that is not a work thread's, and a thread task without a card, have nothing to feed.
	plain := job
	plain.Trigger = daemonruntime.TaskTrigger{Source: "ui"}
	if rt.newSoloParticipantFeed(plain) != nil {
		t.Fatal("an ordinary task got a participant feed")
	}
	var none *soloParticipantFeed
	none.activityUpdated(progress)
	orphan := job
	orphan.TaskID = "task-without-card"
	rt.newSoloParticipantFeed(orphan).activityUpdated(progress)
	if _, ok := rt.store.Get(daemonruntime.SoloThreadCardID("task-without-card")); ok {
		t.Fatal("a feed made a card")
	}
}

// More workers than the roster keeps: the card lists the newest, counts the rest once, and a
// nested worker is one more worker of the task.
func TestSoloParticipantFeedBoundsTheRoster(t *testing.T) {
	rt, job, _ := newSoloParticipantRuntime(t, nil)
	job.Trigger = soloThreadTrigger
	startSoloParticipantTask(t, rt, job.TopicID, job.TaskID)
	feed := rt.newSoloParticipantFeed(job)
	var progress *consoleActivityProgress
	total := consoleActivityWorkerLimit + 5
	for n := 1; n <= total; n++ {
		worker := &agent.WorkerMetadata{ID: fmt.Sprintf("worker-%d", n), Name: fmt.Sprintf("W%d", n)}
		id := fmt.Sprintf("spawn-%d", n)
		event := agent.Event{Kind: agent.EventKindToolStart, ActivityID: id, ToolName: "spawn", Status: "running", Worker: worker}
		if n%2 == 0 {
			// Started by the worker before it: still its own worker of the task.
			event.ParentActivityID = fmt.Sprintf("spawn-%d", n-1)
		}
		for _, e := range []agent.Event{event, {Kind: agent.EventKindToolDone, ActivityID: id, ParentActivityID: event.ParentActivityID, ToolName: "spawn", Status: "done", Worker: worker}} {
			var changed bool
			if progress, changed = updateConsoleActivityProgress(progress, e); changed {
				feed.activityUpdated(progress)
			}
		}
	}
	rec := soloCardOf(t, rt, job.TaskID)
	if len(rec.Participants) != daemonruntime.SoloParticipantLimit || rec.ParticipantsOmitted != 5 {
		t.Fatalf("card = %d participants, %d omitted (activity: %d, %d)", len(rec.Participants), rec.ParticipantsOmitted, len(progress.Workers), progress.WorkersOmitted)
	}
	if rec.Participants[0].ID != "worker-6" || rec.Participants[len(rec.Participants)-1].ID != fmt.Sprintf("worker-%d", total) {
		t.Fatalf("card lists %s .. %s", rec.Participants[0].ID, rec.Participants[len(rec.Participants)-1].ID)
	}
	seen := map[string]bool{}
	for _, p := range rec.Participants {
		if seen[p.ID] {
			t.Fatalf("%s is listed twice", p.ID)
		}
		seen[p.ID] = true
	}
	// The task's end reads the same workers from its result: nobody is counted again.
	if err := rt.store.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
		info.Status = daemonruntime.TaskDone
		info.Result = buildConsoleTaskResult(nil, nil, progress, "")
	}); err != nil {
		t.Fatal(err)
	}
	rt.syncSoloThread(job.TaskID)
	rt.syncSoloThread(job.TaskID)
	rec = soloCardOf(t, rt, job.TaskID)
	if len(rec.Participants) != daemonruntime.SoloParticipantLimit || rec.ParticipantsOmitted != 5 || rec.State != daemonruntime.SoloThreadDone {
		t.Fatalf("ended card = %d participants, %d omitted, %s", len(rec.Participants), rec.ParticipantsOmitted, rec.State)
	}
}

// What the card keeps at a pause, after it, at each kind of end, and when the runtime comes back
// to a task that ended unseen.
func TestSoloThreadParticipantsThroughPauseEndAndRestart(t *testing.T) {
	workers := func(status ...string) *consoleActivityProgress {
		progress := &consoleActivityProgress{}
		names := []string{"Ada", "Milo", "Noor"}
		kinds := []string{"subagent", "coder", "subagent"}
		for i, s := range status {
			progress.Workers = append(progress.Workers, consoleActivityWorker{
				ID: fmt.Sprintf("worker-%d", i+1), Name: names[i], Kind: kinds[i], Status: s,
				Task: "SECRET-ASK", Output: "SECRET-OUT", Result: "SECRET-RESULT",
				Processes: []agent.WorkerProcess{{PID: 424242, Program: "codex"}},
			})
		}
		return progress
	}
	// stored is the result as the store gives it back after a restart: plain JSON values.
	stored := func(progress *consoleActivityProgress) map[string]any {
		raw, err := json.Marshal(buildConsoleTaskResult(nil, nil, progress, ""))
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]any
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	t.Run("pause, resume and end", func(t *testing.T) {
		rt, job, topicID := newSoloParticipantRuntime(t, nil)
		job.Trigger, job.TaskID = soloThreadTrigger, "thread_task_pause"
		startSoloParticipantTask(t, rt, topicID, job.TaskID)
		// The task pauses for an approval: its result has its workers, the card gets them.
		if err := rt.store.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
			info.Status = daemonruntime.TaskPending
			info.Result = buildConsoleTaskResult(nil, nil, workers("done", "running"), "")
		}); err != nil {
			t.Fatal(err)
		}
		rt.syncSoloThread(job.TaskID)
		rec := soloCardOf(t, rt, job.TaskID)
		if rec.State != daemonruntime.SoloThreadWaiting || soloParticipantLine(rec.Participants) != "worker-1/Ada/subagent/done worker-2/Milo/coder/running" {
			t.Fatalf("waiting card = %s %q", rec.State, soloParticipantLine(rec.Participants))
		}
		if _, ok := rt.store.Get(daemonruntime.SoloThreadSummaryID(job.TaskID)); ok {
			t.Fatal("a waiting thread has a summary")
		}
		// It resumes: the new run's activity knows only its own worker, the card keeps them all.
		if err := rt.store.Update(job.TaskID, func(info *daemonruntime.TaskInfo) { info.Status = daemonruntime.TaskRunning }); err != nil {
			t.Fatal(err)
		}
		rt.syncSoloThread(job.TaskID)
		resumed := &consoleActivityProgress{Workers: []consoleActivityWorker{{ID: "worker-3", Name: "Noor", Kind: "subagent", Status: "running"}}}
		rt.newSoloParticipantFeed(job).activityUpdated(resumed)
		rec = soloCardOf(t, rt, job.TaskID)
		if rec.State != daemonruntime.SoloThreadRunning || soloParticipantLine(rec.Participants) != "worker-1/Ada/subagent/done worker-2/Milo/coder/running worker-3/Noor/subagent/running" {
			t.Fatalf("resumed card = %s %q", rec.State, soloParticipantLine(rec.Participants))
		}
		// It is stopped: the workers still marked live were stopped with it.
		if err := rt.store.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
			info.Status = daemonruntime.TaskCanceled
			info.Error = "stopped by user"
			info.Result = stored(resumed)
		}); err != nil {
			t.Fatal(err)
		}
		rt.syncSoloThread(job.TaskID)
		want := "worker-1/Ada/subagent/done worker-2/Milo/coder/canceled worker-3/Noor/subagent/canceled"
		rec = soloCardOf(t, rt, job.TaskID)
		summaryTask, ok := rt.store.Get(daemonruntime.SoloThreadSummaryID(job.TaskID))
		if !ok {
			t.Fatal("no summary")
		}
		summary, _ := solo.ThreadOf(*summaryTask)
		if rec.State != daemonruntime.SoloThreadCanceled || soloParticipantLine(rec.Participants) != want || soloParticipantLine(summary.Participants) != want {
			t.Fatalf("stopped card = %s %q, summary %q", rec.State, soloParticipantLine(rec.Participants), soloParticipantLine(summary.Participants))
		}
		raw, _ := json.Marshal([]any{summaryTask, rec})
		if strings.Contains(string(raw), "SECRET") || strings.Contains(string(raw), "424242") {
			t.Fatalf("records carry more than identities: %s", raw)
		}
	})

	ends := []struct {
		name   string
		status daemonruntime.TaskStatus
		result any
		want   string
	}{
		{"done", daemonruntime.TaskDone, stored(workers("done", "failed", "running")), "worker-1/Ada/subagent/done worker-2/Milo/coder/failed worker-3/Noor/subagent/done"},
		{"failed", daemonruntime.TaskFailed, stored(workers("done", "running", "")), "worker-1/Ada/subagent/done worker-2/Milo/coder/failed worker-3/Noor/subagent/failed"},
		// The runtime died mid-run: the task was failed without a result, the card keeps who it had.
		{"failed by recovery", daemonruntime.TaskFailed, nil, "worker-1/Ada/subagent/done worker-2/Milo/coder/failed"},
		{"result without workers", daemonruntime.TaskDone, map[string]any{"final": map[string]any{"output": "ok"}, "activity": map[string]any{"history": []any{}}}, "worker-1/Ada/subagent/done worker-2/Milo/coder/done"},
		{"broken activity", daemonruntime.TaskDone, map[string]any{"activity": "not an activity"}, "worker-1/Ada/subagent/done worker-2/Milo/coder/done"},
	}
	for i, c := range ends {
		t.Run(c.name, func(t *testing.T) {
			rt, job, topicID := newSoloParticipantRuntime(t, nil)
			job.Trigger, job.TaskID = soloThreadTrigger, fmt.Sprintf("thread_task_end_%d", i)
			startSoloParticipantTask(t, rt, topicID, job.TaskID)
			rt.newSoloParticipantFeed(job).activityUpdated(workers("done", "running"))
			if err := rt.store.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
				info.Status = c.status
				info.Result = c.result
			}); err != nil {
				t.Fatal(err)
			}
			// Nothing watched the end (as after a restart): the check at startup catches up, once.
			rt.reconcileSoloThreads()
			rt.reconcileSoloThreads()
			rec := soloCardOf(t, rt, job.TaskID)
			summaryTask, ok := rt.store.Get(daemonruntime.SoloThreadSummaryID(job.TaskID))
			if !ok {
				t.Fatal("no summary")
			}
			summary, _ := solo.ThreadOf(*summaryTask)
			if soloParticipantLine(rec.Participants) != c.want || soloParticipantLine(summary.Participants) != c.want || rec.FinishedAt == "" {
				t.Fatalf("card = %q, summary = %q, want %q", soloParticipantLine(rec.Participants), soloParticipantLine(summary.Participants), c.want)
			}
		})
	}

	t.Run("no workers and old cards", func(t *testing.T) {
		rt, job, topicID := newSoloParticipantRuntime(t, nil)
		job.Trigger, job.TaskID = soloThreadTrigger, "thread_task_plain"
		startSoloParticipantTask(t, rt, topicID, job.TaskID)
		rt.newSoloParticipantFeed(job).activityUpdated(&consoleActivityProgress{History: []consoleActivityEntry{{ID: "bash-1", Kind: "tool", Name: "bash", Status: "done"}}})
		if err := rt.store.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
			info.Status = daemonruntime.TaskDone
			info.Result = map[string]any{"final": map[string]any{"output": "ok"}}
		}); err != nil {
			t.Fatal(err)
		}
		rt.syncSoloThread(job.TaskID)
		for _, id := range []string{daemonruntime.SoloThreadCardID(job.TaskID), daemonruntime.SoloThreadSummaryID(job.TaskID)} {
			task, ok := rt.store.Get(id)
			if !ok {
				t.Fatalf("no %s", id)
			}
			raw, _ := json.Marshal(task.Result)
			if strings.Contains(string(raw), "participants") {
				t.Fatalf("%s has a participants field without workers: %s", id, raw)
			}
		}
	})

	// A continued thread: each task of the topic has its own card and its own workers.
	t.Run("per task", func(t *testing.T) {
		rt, job, topicID := newSoloParticipantRuntime(t, nil)
		job.Trigger = soloThreadTrigger
		first, second := job, job
		first.TaskID, second.TaskID = "thread_task_first", "thread_task_second"
		startSoloParticipantTask(t, rt, topicID, first.TaskID)
		rt.newSoloParticipantFeed(first).activityUpdated(workers("done", "done"))
		if err := rt.store.Update(first.TaskID, func(info *daemonruntime.TaskInfo) { info.Status = daemonruntime.TaskDone }); err != nil {
			t.Fatal(err)
		}
		rt.syncSoloThread(first.TaskID)
		startSoloParticipantTask(t, rt, topicID, second.TaskID)
		// The second task's first worker has the first task's first worker's ID.
		rt.newSoloParticipantFeed(second).activityUpdated(&consoleActivityProgress{Workers: []consoleActivityWorker{{ID: "worker-1", Name: "Zed", Kind: "coder", Status: "running"}}})
		if got := soloParticipantLine(soloCardOf(t, rt, first.TaskID).Participants); got != "worker-1/Ada/subagent/done worker-2/Milo/coder/done" {
			t.Fatalf("first task's card = %q", got)
		}
		if got := soloParticipantLine(soloCardOf(t, rt, second.TaskID).Participants); got != "worker-1/Zed/coder/running" {
			t.Fatalf("second task's card = %q", got)
		}
	})
}

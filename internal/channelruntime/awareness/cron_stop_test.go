package awareness

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// waitFor polls cond until it holds or two seconds pass.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func currentRun(path, id string) (cronstore.TaskRun, bool) {
	for _, run := range cronstore.Runs(path) {
		if run.ID == id {
			return run, true
		}
	}
	return cronstore.TaskRun{}, false
}

func finishedRun(path, runID string) (cronstore.FinishedRun, bool) {
	for _, f := range cronstore.FinishedRuns(path) {
		if f.RunID == runID {
			return f, true
		}
	}
	return cronstore.FinishedRun{}, false
}

func runningID(t *testing.T, path, id string) string {
	t.Helper()
	var run cronstore.TaskRun
	waitFor(t, id+" running", func() bool {
		var ok bool
		run, ok = currentRun(path, id)
		return ok && run.State == cronstore.RunRunning
	})
	if run.RunID == "" {
		t.Fatalf("%s has no run id: %+v", id, run)
	}
	return run.RunID
}

func seedTask(t *testing.T, path string, task cronstore.Task) {
	t.Helper()
	store := cronstore.NewStore(path)
	file, _, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	file.Version = cronstore.Version
	file.Tasks = append(file.Tasks, task)
	if err := store.Write(file); err != nil {
		t.Fatal(err)
	}
}

func storedTask(t *testing.T, path, id string) cronstore.Task {
	t.Helper()
	task, found, err := cronstore.NewStore(path).FindByID(id)
	if err != nil || !found {
		t.Fatalf("task %s: found=%v err=%v", id, found, err)
	}
	return task
}

func TestCronStopCancelsOnlyThatExecution(t *testing.T) {
	h := startCronHarness(t, 2, nil)
	long := cronstore.Task{ID: "long", Cron: "0 10 * * *", TZ: "UTC", Content: "Run long."}
	seedTask(t, h.path, long)
	if err := h.trigger("long"); err != nil {
		t.Fatal(err)
	}
	h.waitStarted("long")
	if err := h.trigger("other"); err != nil {
		t.Fatal(err)
	}
	h.waitStarted("other")
	runID := runningID(t, h.path, "long")

	got := cronstore.StopRun(h.path, "long", runID)
	if got.Status != cronstore.StopStopping {
		t.Fatalf("stop = %+v", got)
	}
	var finished cronstore.FinishedRun
	waitFor(t, "the stopped run to end", func() bool {
		var ok bool
		finished, ok = finishedRun(h.path, runID)
		return ok
	})
	if finished.Status != cronstore.RunStatusCanceled || !finished.Stopping {
		t.Fatalf("finished = %+v, want canceled", finished)
	}
	// The other item runs on.
	if h.states()["other"] != cronstore.RunRunning {
		t.Fatalf("states = %v, want other running", h.states())
	}
	// The item is kept as it was, with the stop recorded as its last run.
	task := storedTask(t, h.path, "long")
	if !cronstore.TaskEnabled(task) || task.Cron != long.Cron || task.LastRunStatus != cronstore.RunStatusCanceled {
		t.Fatalf("stored task = %+v", task)
	}

	// The item's next run is a new execution: the old run's ID does not stop it.
	if err := h.trigger("long"); err != nil {
		t.Fatal(err)
	}
	h.waitStarted("long")
	nextID := runningID(t, h.path, "long")
	if nextID == runID {
		t.Fatal("the next run kept the stopped run's id")
	}
	if late := cronstore.StopRun(h.path, "long", runID); late.Status != cronstore.RunStatusCanceled {
		t.Fatalf("stop with the old id = %+v, want its recorded end", late)
	}
	h.expectNoStart()
	if run, ok := currentRun(h.path, "long"); !ok || run.RunID != nextID || run.Stopping {
		t.Fatalf("next run after a stale stop = %+v (%v)", run, ok)
	}
	h.finish("long")
	waitFor(t, "the next run to finish", func() bool {
		f, ok := finishedRun(h.path, nextID)
		return ok && f.Status == cronstore.RunStatusDone
	})
	if task := storedTask(t, h.path, "long"); task.LastRunStatus != cronstore.RunStatusDone {
		t.Fatalf("last run after the next run = %q", task.LastRunStatus)
	}
	h.finish("other")
}

func TestCronStopWhileQueuedNeverStartsIt(t *testing.T) {
	h := startCronHarness(t, 1, nil)
	seedTask(t, h.path, cronstore.Task{ID: "next", Cron: "0 10 * * *", TZ: "UTC", Content: "Run next."})
	if err := h.trigger("long"); err != nil {
		t.Fatal(err)
	}
	h.waitStarted("long")
	if err := h.trigger("next"); err != nil {
		t.Fatal(err)
	}
	run, ok := currentRun(h.path, "next")
	if !ok || run.State != cronstore.RunQueued {
		t.Fatalf("next = %+v (%v), want queued", run, ok)
	}
	if got := cronstore.StopRun(h.path, "next", run.RunID); got.Status != cronstore.StopStopping {
		t.Fatalf("stop = %+v", got)
	}
	h.finish("long")
	h.expectNoStart()
	f, ok := finishedRun(h.path, run.RunID)
	if !ok || f.Status != cronstore.RunStatusCanceled {
		t.Fatalf("finished = %+v (%v)", f, ok)
	}
	// It never ran, so it has no last run.
	if task := storedTask(t, h.path, "next"); task.LastRunAt != "" || task.LastRunStatus != "" {
		t.Fatalf("stored task = %+v", task)
	}
	// And it can run again.
	if err := h.trigger("next"); err != nil {
		t.Fatal(err)
	}
	h.waitStarted("next")
	h.finish("next")
}

// A run that completes although a stop came in (its work was done) is recorded as done.
func TestCronStopLosesToCompletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cron.yaml")
	seedTask(t, path, cronstore.Task{ID: "quick", Cron: "0 10 * * *", TZ: "UTC", Content: "Run quick."})
	requests := make(chan CronRequest)
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		RunCronLoop(ctx, CronLoopOptions{
			Path:     path,
			Requests: requests,
			Now:      func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
			Run: func(runCtx context.Context, _ cronstore.DueTask) error {
				started <- struct{}{}
				<-runCtx.Done()
				<-release
				return nil
			},
		})
	}()
	defer func() {
		cancel()
		<-done
	}()
	if err := TriggerCron(ctx, requests, cronstore.Task{ID: "quick", Cron: "0 10 * * *", Content: "Run quick."}); err != nil {
		t.Fatal(err)
	}
	<-started
	runID := runningID(t, path, "quick")
	if got := cronstore.StopRun(path, "quick", runID); got.Status != cronstore.StopStopping {
		t.Fatalf("stop = %+v", got)
	}
	close(release)
	var f cronstore.FinishedRun
	waitFor(t, "the run to end", func() bool {
		var ok bool
		f, ok = finishedRun(path, runID)
		return ok
	})
	if f.Status != cronstore.RunStatusDone || !f.Stopping {
		t.Fatalf("finished = %+v, want done with a stop asked", f)
	}
	if task := storedTask(t, path, "quick"); task.LastRunStatus != cronstore.RunStatusDone {
		t.Fatalf("last run = %q", task.LastRunStatus)
	}
}

// blockingCronClient waits in each call until its context ends; once released it answers.
type blockingCronClient struct {
	mu       sync.Mutex
	calls    int
	causes   []error
	started  chan struct{}
	released bool
}

func (c *blockingCronClient) Chat(ctx context.Context, _ llm.Request) (llm.Result, error) {
	c.mu.Lock()
	c.calls++
	released := c.released
	c.mu.Unlock()
	if released {
		return llm.Result{Text: `{"type":"final","output":"ok"}`}, nil
	}
	c.started <- struct{}{}
	<-ctx.Done()
	c.mu.Lock()
	c.causes = append(c.causes, context.Cause(ctx))
	c.mu.Unlock()
	return llm.Result{}, ctx.Err()
}

func (c *blockingCronClient) release() {
	c.mu.Lock()
	c.released = true
	c.mu.Unlock()
}

// Stopping a TODO item's run reaches the agent run the awareness loop started for it: its LLM call
// is cancelled with the stop as the cause, the task record ends canceled, and the loop goes on.
func TestAwarenessCronStopCancelsTheAgentRun(t *testing.T) {
	dir := t.TempDir()
	cronPath := filepath.Join(dir, "cron.yaml")
	task := cronstore.Task{ID: "agent-task", Title: "Agent task", Cron: "0 10 * * *", TZ: "UTC", Content: "Do the work."}
	seedTask(t, cronPath, task)
	client := &blockingCronClient{started: make(chan struct{}, 4)}
	taskStore := &awarenessTaskRecordStore{MemoryStore: daemonruntime.NewMemoryStore(20)}
	requests := make(chan CronRequest)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, depsutil.CommonDependencies{
			Logger: func() (*slog.Logger, error) { return slog.New(slog.DiscardHandler), nil },
			ResolveLLMRoute: func(purpose string) (llmutil.ResolvedRoute, error) {
				return llmutil.ResolvedRoute{Purpose: purpose, ClientConfig: llmconfig.ClientConfig{Provider: "test", Model: "m"}}, nil
			},
			CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil },
			PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
				return agent.DefaultPromptSpec(), nil, nil
			},
			AwarenessRegistry: func() *tools.Registry { return tools.NewRegistry() },
		}, RunOptions{
			DisableHeartbeat:    true,
			CronEnabled:         true,
			CronPath:            cronPath,
			CronRequests:        requests,
			ChatInfoStateDir:    dir,
			ChatInfoContactsDir: filepath.Join(dir, "contacts"),
			TaskStore:           taskStore,
		})
	}()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("awareness loop did not stop")
		}
	}()
	trigger := func() {
		t.Helper()
		triggerCtx, triggerCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer triggerCancel()
		if err := TriggerCron(triggerCtx, requests, task); err != nil {
			t.Fatal(err)
		}
	}
	trigger()
	select {
	case <-client.started:
	case <-time.After(3 * time.Second):
		t.Fatal("the agent run did not call the LLM")
	}
	runID := runningID(t, cronPath, task.ID)
	if got := cronstore.StopRun(cronPath, task.ID, runID); got.Status != cronstore.StopStopping {
		t.Fatalf("stop = %+v", got)
	}
	var f cronstore.FinishedRun
	waitFor(t, "the agent run to end", func() bool {
		var ok bool
		f, ok = finishedRun(cronPath, runID)
		return ok
	})
	if f.Status != cronstore.RunStatusCanceled {
		t.Fatalf("finished = %+v, want canceled", f)
	}
	client.mu.Lock()
	causes := append([]error(nil), client.causes...)
	client.mu.Unlock()
	if len(causes) != 1 || !errors.Is(causes[0], cronstore.ErrRunStopped) {
		t.Fatalf("LLM call causes = %v, want the stop", causes)
	}
	items := taskStore.List(daemonruntime.TaskListOptions{Limit: 10})
	if len(items) != 1 || items[0].Status != daemonruntime.TaskCanceled || items[0].Error != cronstore.ErrRunStopped.Error() {
		t.Fatalf("task records = %+v", items)
	}
	if stored := storedTask(t, cronPath, task.ID); !cronstore.TaskEnabled(stored) || stored.Cron != task.Cron ||
		stored.LastRunStatus != cronstore.RunStatusCanceled {
		t.Fatalf("stored task = %+v", stored)
	}

	// The loop is unharmed: the item's next run works to the end.
	client.release()
	trigger()
	nextID := ""
	waitFor(t, "the next run to finish", func() bool {
		for _, f := range cronstore.FinishedRuns(cronPath) {
			if f.RunID != runID && f.ID == task.ID {
				nextID = f.RunID
				return f.Status == cronstore.RunStatusDone
			}
		}
		return false
	})
	if nextID == "" {
		t.Fatal("no next run")
	}
}

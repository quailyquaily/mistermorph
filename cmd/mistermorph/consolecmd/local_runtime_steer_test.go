package consolecmd

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/spf13/viper"
)

type consoleSteerFixture struct {
	rt      *consoleLocalRuntime
	store   *daemonruntime.ConsoleFileStore
	control *runtimecontrol.RunControl
	lease   *runtimecontrol.RunLease
	topicID string

	mu       sync.Mutex
	requests []llm.Request
	reply    func(req llm.Request) (llm.Result, error)
}

func newConsoleSteerFixture(t *testing.T) *consoleSteerFixture {
	t.Helper()
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{Persist: false})
	if err != nil {
		t.Fatalf("NewConsoleFileStore() error = %v", err)
	}
	topic, err := store.CreateTopic("Topic A")
	if err != nil {
		t.Fatalf("CreateTopic() error = %v", err)
	}
	f := &consoleSteerFixture{store: store, topicID: topic.ID}
	f.reply = func(req llm.Request) (llm.Result, error) {
		return llm.Result{Text: "Understood, I'll keep the answer short from here on."}, nil
	}
	generation := &consoleLocalRuntimeGeneration{reader: viper.New(), commonDeps: depsutil.CommonDependencies{
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) {
			return llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "test", Model: "main-model"}}, nil
		},
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) {
			return topicNamingClientFunc(func(_ context.Context, req llm.Request) (llm.Result, error) {
				f.mu.Lock()
				f.requests = append(f.requests, req)
				reply := f.reply
				f.mu.Unlock()
				return reply(req)
			}), nil
		},
	}}
	f.rt = &consoleLocalRuntime{store: store, generation: generation, consoleExecutionState: newConsoleExecutionState(nil, nil)}
	f.control = f.rt.runControl
	now := time.Now().UTC()
	if err := store.Upsert(daemonruntime.TaskInfo{ID: "task_earlier", TopicID: topic.ID, Task: "What is a haiku?", Status: daemonruntime.TaskDone, CreatedAt: now.Add(-time.Minute), FinishedAt: &now, Result: map[string]any{"final": map[string]any{"output": "A short Japanese poem."}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert(daemonruntime.TaskInfo{ID: "task_active", TopicID: topic.ID, Task: "Write three haiku about autumn", Status: daemonruntime.TaskRunning, CreatedAt: now, Model: "main-model"}); err != nil {
		t.Fatal(err)
	}
	job := consoleLocalTaskJob{TaskID: "task_active", TopicID: topic.ID, Task: "Write three haiku about autumn", CreatedAt: now}
	f.lease, err = f.control.StartLease(context.Background(), time.Minute, runtimecontrol.ActiveRun{
		Runtime:         "console",
		ConversationKey: buildConsoleConversationKey(topic.ID),
		TopicID:         topic.ID,
		TaskID:          "task_active",
		RunID:           "task_active",
		Snapshot:        func() string { return "Step 1 of 3: drafting the first haiku" },
		Task:            job.Task,
		Conversation:    f.rt.steerConsoleConversation(job),
	})
	if err != nil {
		t.Fatalf("StartLease() error = %v", err)
	}
	t.Cleanup(func() {
		f.lease.Finish()
		f.rt.cancelWorkers()
	})
	return f
}

func (f *consoleSteerFixture) submit(t *testing.T, text string) daemonruntime.SubmitTaskResponse {
	t.Helper()
	resp, err := f.rt.submitTask(context.Background(), daemonruntime.SubmitTaskRequest{Task: text, TopicID: f.topicID})
	if err != nil {
		t.Fatalf("submitTask(%q) error = %v", text, err)
	}
	return resp
}

func (f *consoleSteerFixture) output(t *testing.T, taskID string) (*daemonruntime.TaskInfo, string) {
	t.Helper()
	task, ok := f.store.Get(taskID)
	if !ok || task == nil {
		t.Fatalf("store.Get(%q) missing", taskID)
	}
	return task, chathistory.TaskResultOutput(task.Result)
}

func TestConsoleSteerGetsAContextualLLMReply(t *testing.T) {
	f := newConsoleSteerFixture(t)
	resp := f.submit(t, "请改成简短回答")
	if resp.Status != daemonruntime.TaskRunning || resp.SteerTargetTaskID != "task_active" {
		t.Fatalf("submit response = %+v, want a running steer of task_active", resp)
	}
	f.rt.steerResponder().Wait()

	if items := f.lease.SteerQueue.Drain(); len(items) != 1 || items[0] != "请改成简短回答" {
		t.Fatalf("steer queue = %#v, want the message for the running task", items)
	}
	if f.lease.Context.Err() != nil {
		t.Fatalf("steer canceled the active run: %v", f.lease.Context.Err())
	}
	task, output := f.output(t, resp.ID)
	if task.Status != daemonruntime.TaskDone || task.SteerTargetTaskID != "task_active" {
		t.Fatalf("steer task = %+v", task)
	}
	if output != "Understood, I'll keep the answer short from here on." {
		t.Fatalf("steer reply = %q", output)
	}
	if len(f.requests) != 1 {
		t.Fatalf("LLM requests = %d, want 1", len(f.requests))
	}
	req := f.requests[0]
	if req.Model != "main-model" || len(req.Tools) != 0 || req.Scene != "runtime.steer_reply" {
		t.Fatalf("reply request = model %q scene %q tools %d", req.Model, req.Scene, len(req.Tools))
	}
	prompt := req.Messages[1].Content
	for _, want := range []string{"Write three haiku about autumn", "What is a haiku?", "A short Japanese poem.", "drafting the first haiku", "请改成简短回答"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("reply prompt misses %q:\n%s", want, prompt)
		}
	}
	if target, _ := f.store.Get("task_active"); target == nil || target.Status != daemonruntime.TaskRunning {
		t.Fatalf("target task = %+v, want still running", target)
	}
}

func TestConsoleSteerCommandInputGetsAReply(t *testing.T) {
	f := newConsoleSteerFixture(t)
	resp := f.submit(t, "/think consider a winter haiku too")
	f.rt.steerResponder().Wait()
	if resp.SteerTargetTaskID != "task_active" {
		t.Fatalf("submit response = %+v, want a steer", resp)
	}
	if items := f.lease.SteerQueue.Drain(); len(items) != 1 || items[0] != "/think consider a winter haiku too" {
		t.Fatalf("steer queue = %#v", items)
	}
	if _, output := f.output(t, resp.ID); !strings.Contains(output, "Understood") {
		t.Fatalf("reply = %q", output)
	}
}

func TestConsoleSuccessiveSteersEachGetTheirReplyInOrder(t *testing.T) {
	f := newConsoleSteerFixture(t)
	f.reply = func(req llm.Request) (llm.Result, error) {
		prompt := req.Messages[1].Content
		switch {
		case strings.Contains(prompt, `"message": "second change"`):
			if !strings.Contains(prompt, "Reply one.") {
				return llm.Result{Text: "Reply two, without the first."}, nil
			}
			return llm.Result{Text: "Reply two."}, nil
		case strings.Contains(prompt, `"message": "first change"`):
			time.Sleep(20 * time.Millisecond)
			return llm.Result{Text: "Reply one."}, nil
		}
		return llm.Result{}, fmt.Errorf("unexpected prompt %s", prompt)
	}
	first := f.submit(t, "first change")
	second := f.submit(t, "second change")
	f.rt.steerResponder().Wait()
	if _, out := f.output(t, first.ID); out != "Reply one." {
		t.Fatalf("first reply = %q", out)
	}
	if _, out := f.output(t, second.ID); out != "Reply two." {
		t.Fatalf("second reply = %q", out)
	}
	if len(f.requests) != 2 {
		t.Fatalf("LLM requests = %d, want one per message", len(f.requests))
	}
	if items := f.lease.SteerQueue.Drain(); len(items) != 2 || items[0] != "first change" || items[1] != "second change" {
		t.Fatalf("steer queue = %#v", items)
	}
}

func TestConsoleSteerReplyFailureIsExplicit(t *testing.T) {
	for _, mode := range []string{"error", "emoji"} {
		t.Run(mode, func(t *testing.T) {
			f := newConsoleSteerFixture(t)
			f.reply = func(llm.Request) (llm.Result, error) {
				if mode == "error" {
					return llm.Result{}, errors.New("rate limited")
				}
				return llm.Result{Text: "👌"}, nil
			}
			resp := f.submit(t, "use British spelling")
			f.rt.steerResponder().Wait()
			task, output := f.output(t, resp.ID)
			if task.Status != daemonruntime.TaskDone || !strings.Contains(output, "could not write a reply") || output == "👌" {
				t.Fatalf("steer task = %+v output %q", task, output)
			}
			if mode == "error" && !strings.Contains(output, "rate limited") {
				t.Fatalf("output %q does not say why", output)
			}
			if items := f.lease.SteerQueue.Drain(); len(items) != 1 {
				t.Fatalf("a failed reply lost the steer: %#v", items)
			}
		})
	}
}

func TestConsoleSteerIntoAStoppingTaskSaysItWasNotAdded(t *testing.T) {
	f := newConsoleSteerFixture(t)
	f.control.Stop("console", buildConsoleConversationKey(f.topicID), "/stop")
	resp := f.submit(t, "actually, make it four")
	f.rt.steerResponder().Wait()
	if resp.SteerTargetTaskID != "" {
		t.Fatalf("submit response = %+v, want no steer target", resp)
	}
	task, output := f.output(t, resp.ID)
	if task.Status != daemonruntime.TaskDone || !strings.Contains(output, "not added") || len(f.requests) != 0 {
		t.Fatalf("steer task = %+v output %q requests %d", task, output, len(f.requests))
	}
}

func TestConsoleSteerWhenTheTaskEndsBeforeTakingItIn(t *testing.T) {
	f := newConsoleSteerFixture(t)
	writing, release := make(chan struct{}), make(chan struct{})
	f.reply = func(llm.Request) (llm.Result, error) {
		close(writing)
		<-release
		return llm.Result{Text: "I'll add a fourth haiku."}, nil
	}
	resp := f.submit(t, "add a fourth one")
	<-writing
	f.lease.Finish()
	close(release)
	f.rt.steerResponder().Wait()
	_, output := f.output(t, resp.ID)
	if strings.Contains(output, "fourth haiku") || !strings.Contains(output, "not applied") {
		t.Fatalf("reply = %q, want a not-applied notice instead", output)
	}
}

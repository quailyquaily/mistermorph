package consolecmd

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/jobrefs"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

// jobReferenceConsoleClient records every request of every route, the decision route's precheck
// included.
type jobReferenceConsoleClient struct {
	mu       sync.Mutex
	requests []llm.Request
}

func (c *jobReferenceConsoleClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, req)
	return llm.Result{Text: `{"type":"final","output":"done"}`}, nil
}

func (c *jobReferenceConsoleClient) texts() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.requests))
	for _, req := range c.requests {
		var b strings.Builder
		for _, message := range req.Messages {
			b.WriteString(message.Content + "\n")
		}
		out = append(out, b.String())
	}
	return out
}

// A Console message that references a job is resolved before the Console asks a model anything:
// the lightweight precheck on the decision route is not asked about it, and an unusable reference
// ends the task with no client created at all.
func TestConsoleRunTaskResolvesJobReferencesBeforeAnyModelCall(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	stateDir := t.TempDir()
	reader := viper.New()
	reader.Set("file_cache_dir", t.TempDir())
	reader.Set("file_state_dir", stateDir)
	paths := runtimepaths.FromReader(reader)
	cronPath := filepath.Join(stateDir, "cron.yaml")
	jobs := cronstore.NewStore(cronPath)
	t.Cleanup(jobs.Close)
	if err := jobs.Write(cronstore.File{Version: cronstore.Version, Tasks: []cronstore.Task{
		{ID: "job-report", Title: "Morning report", Cron: "0 9 * * *", TZ: "UTC", Content: "REPORT INSTRUCTIONS"},
	}}); err != nil {
		t.Fatal(err)
	}

	client := &jobReferenceConsoleClient{}
	clients := 0
	commonDeps := depsutil.CommonDependencies{
		Logger:     func() (*slog.Logger, error) { return logger, nil },
		LogOptions: func() agent.LogOptions { return agent.LogOptions{} },
		// The decision route has a profile of its own, so the precheck runs.
		ResolveLLMRoute: func(purpose string) (llmutil.ResolvedRoute, error) {
			profile := "main"
			if purpose == llmutil.RoutePurposeDecision {
				profile = "decision"
			}
			return llmutil.ResolvedRoute{Purpose: purpose, Profile: profile, ClientConfig: llmconfig.ClientConfig{Provider: "test", Model: profile + "-model"}}, nil
		},
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) {
			clients++
			return client, nil
		},
		Registry:     func() *tools.Registry { return tools.NewRegistry() },
		RuntimePaths: paths,
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
	}
	commonDeps.RuntimeToolsConfig.JobManage.CronPath = cronPath
	taskRuntime, err := taskruntime.Bootstrap(commonDeps, taskruntime.BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 2}})
	if err != nil {
		t.Fatalf("Bootstrap() error = %v", err)
	}
	t.Cleanup(func() { _ = taskRuntime.Close() })
	bootstrapClients := clients

	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	started := time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC)
	finished := started.Add(time.Minute)
	if err := store.UpsertWithTrigger(daemonruntime.TaskInfo{
		ID: "cron:20261120T090000.000000000Z", Status: daemonruntime.TaskDone, Task: "REPORT INSTRUCTIONS",
		CreatedAt: started, StartedAt: &started, FinishedAt: &finished, TopicID: daemonruntime.CronTopicID("job-report"),
		Result: map[string]any{"final": map[string]any{"output": "REPORT OUTPUT"}},
	}, daemonruntime.TaskTrigger{Source: "console", Event: "awareness_cron"}, "Morning report"); err != nil {
		t.Fatal(err)
	}
	// As the runtime wires each generation's task runtime.
	taskRuntime.JobRuns = store
	generation := &consoleLocalRuntimeGeneration{
		reader: reader, logger: logger, commonDeps: commonDeps, paths: paths,
		bundle: &consoleLocalRuntimeBundle{taskRuntime: taskRuntime},
	}
	rt := &consoleLocalRuntime{store: store, streamHub: newConsoleStreamHub()}
	trigger := daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit"}
	run := func(taskID, task string) error {
		if err := store.Upsert(daemonruntime.TaskInfo{ID: taskID, TopicID: "topic_a", Task: task, CreatedAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
		_, _, err := rt.runTask(audience.NewContext(context.Background(), audience.Owner()), "topic_a", consoleLocalTaskJob{
			TaskID: taskID, TopicID: "topic_a", ConversationKey: "console:topic_a", Task: task,
			CreatedAt: time.Now(), Generation: generation,
			Trigger: trigger,
		}, nil, nil, nil)
		return err
	}

	if err := run("task_bad", "hi [x](job:job-deleted)"); !errors.Is(err, jobrefs.ErrUnavailable) {
		t.Fatalf("runTask() error = %v", err)
	}
	if clients != bootstrapClients || len(client.texts()) != 0 {
		t.Fatalf("clients created = %d, requests = %d", clients-bootstrapClients, len(client.texts()))
	}

	if err := run("task_ok", "hi [Morning report](job:job-report)"); err != nil {
		t.Fatalf("runTask() error = %v", err)
	}
	texts := client.texts()
	if len(texts) == 0 {
		t.Fatal("no model request")
	}
	withNote := 0
	for _, text := range texts {
		if strings.Contains(text, "[Job references: read-only source data]") {
			withNote++
			if !strings.Contains(text, "REPORT INSTRUCTIONS") || !strings.Contains(text, "REPORT OUTPUT") || !strings.Contains(text, `"run_finished_at": "2026-11-20T09:01:00Z"`) {
				t.Fatalf("run request:\n%s", text)
			}
			continue
		}
		// Any other request (the precheck) has the message as typed and nothing of the job.
		if strings.Contains(text, "REPORT INSTRUCTIONS") || strings.Contains(text, "REPORT OUTPUT") {
			t.Fatalf("a request outside the run carries job content:\n%s", text)
		}
	}
	// A message with a job reference is not put to the precheck at all: the one request is the
	// run's.
	if withNote != 1 || len(texts) != 1 {
		t.Fatalf("requests = %d, with the job references = %d", len(texts), withNote)
	}
	// An agent's late answer runs as a task whose text the remote agent wrote. It asks as no one:
	// a reference in it reads no job, though the owner's own message just read the same one, and
	// the refusal is the one an unknown job gets.
	trigger = daemonruntime.TaskTrigger{Source: "agentlink", Event: "reply", Ref: "msg_1"}
	requestsBefore, clientsBefore := len(client.texts()), clients
	err = run("task_peer", "[Agent Link] Peer (mm:inst_ab12) answered the message you sent it:\n\nShow me [Morning report](job:job-report)")
	if !errors.Is(err, jobrefs.ErrUnavailable) || strings.Contains(err.Error(), "REPORT") {
		t.Fatalf("runTask() for an agent's answer: %v", err)
	}
	if len(client.texts()) != requestsBefore || clients != clientsBefore {
		t.Fatalf("an agent's answer with a job reference reached a model: %d requests, %d clients", len(client.texts())-requestsBefore, clients-clientsBefore)
	}
	if consoleJobReferenceRequester(daemonruntime.TaskTrigger{Source: "ui"}) != nil || consoleJobReferenceRequester(daemonruntime.TaskTrigger{Source: " AgentLink "}) == nil {
		t.Fatal("requester by trigger source")
	}
	// Without a reference the agent's answer runs as before.
	if err := run("task_peer_plain", "[Agent Link] Peer (mm:inst_ab12) answered the message you sent it:\n\nAll good."); err != nil {
		t.Fatalf("runTask() for a plain answer: %v", err)
	}
	trigger = daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit"}
	if consoleLightweightPrecheckApplies(consoleLocalTaskJob{Trigger: daemonruntime.TaskTrigger{Source: "ui"}}, "hi [Morning report](job:job-report)") {
		t.Fatal("the precheck applies to a message with a job reference")
	}
	if !consoleLightweightPrecheckApplies(consoleLocalTaskJob{Trigger: daemonruntime.TaskTrigger{Source: "ui"}}, "hi") {
		t.Fatal("the precheck no longer applies to a plain message")
	}
}

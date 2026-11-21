package taskruntime

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/jobrefs"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

// jobReferenceRuntime is a runtime with a job list, the Console's run store and a client that
// records what it is asked. promptSpecs counts the prompt builds, the first step that may ask a
// model (skill selection).
type jobReferenceRuntime struct {
	rt          *Runtime
	client      *stubTaskRuntimeClient
	jobs        *cronstore.Store
	runs        *daemonruntime.ConsoleFileStore
	clients     int
	promptSpecs int
}

func newJobReferenceRuntime(t *testing.T, tasks ...cronstore.Task) *jobReferenceRuntime {
	t.Helper()
	env := &jobReferenceRuntime{client: &stubTaskRuntimeClient{}}
	cronPath := filepath.Join(t.TempDir(), "cron.yaml")
	env.jobs = cronstore.NewStore(cronPath)
	t.Cleanup(env.jobs.Close)
	if err := env.jobs.Write(cronstore.File{Version: cronstore.Version, Tasks: tasks}); err != nil {
		t.Fatal(err)
	}
	runs, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	env.runs = runs
	deps := lifecycleTaskRuntimeDeps(func(llmutil.ResolvedRoute) (llm.Client, error) {
		env.clients++
		return env.client, nil
	})
	deps.RuntimeToolsConfig.JobManage.CronPath = cronPath
	deps.PromptSpec = func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
		env.promptSpecs++
		return agent.DefaultPromptSpec(), nil, nil
	}
	rt, err := NewRunPreparer(deps, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 1}})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	rt.JobRuns = runs
	env.rt = rt
	return env
}

// recordRun records one run of a job as the scheduler's runs are recorded: under the job's topic,
// with the final output in result.final.output.
func (env *jobReferenceRuntime) recordRun(t *testing.T, jobID string, startedAt time.Time, status daemonruntime.TaskStatus, output string) {
	t.Helper()
	finished := startedAt.Add(90 * time.Second)
	info := daemonruntime.TaskInfo{
		ID:        "cron:" + startedAt.UTC().Format("20060102T150405.000000000Z07:00"),
		Status:    status,
		Task:      "run",
		CreatedAt: startedAt,
		StartedAt: &startedAt,
		TopicID:   daemonruntime.CronTopicID(jobID),
	}
	switch status {
	case daemonruntime.TaskDone:
		info.FinishedAt = &finished
		info.Result = map[string]any{"final": map[string]any{"output": output}}
	case daemonruntime.TaskFailed:
		info.FinishedAt = &finished
		info.Error = output
	}
	if err := env.runs.UpsertWithTrigger(info, daemonruntime.TaskTrigger{Source: "console", Event: "awareness_cron"}, "job"); err != nil {
		t.Fatal(err)
	}
}

// requestText is everything a model request says after the system prompt.
func requestText(req llm.Request) string {
	var b strings.Builder
	for _, message := range req.Messages[1:] {
		b.WriteString(message.Role + ": " + message.Content + "\n")
	}
	return b.String()
}

func ownerContext() context.Context {
	return audience.NewContext(context.Background(), audience.Owner())
}

func TestRunGivesReferencedJobAsContextNote(t *testing.T) {
	env := newJobReferenceRuntime(t, cronstore.Task{ID: "job-report", Title: "Morning report", Cron: "0 9 * * *", TZ: "Asia/Tokyo", Content: "Summarize the overnight alerts."})
	day := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	env.recordRun(t, "job-report", day, daemonruntime.TaskDone, "Two alerts, both resolved.")
	env.recordRun(t, "job-report", day.Add(24*time.Hour), daemonruntime.TaskFailed, "provider timeout")

	task := "What did [Morning report](job:job-report) say? Also see [it again](job:job-report)."
	result, err := env.rt.Run(ownerContext(), RunRequest{Task: task})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Final == nil || len(env.client.requests) != 1 {
		t.Fatalf("final = %#v, requests = %d", result.Final, len(env.client.requests))
	}
	request := env.client.requests[0]
	text := requestText(request)
	for _, want := range []string{
		"[Job references: read-only source data]",
		`"id": "job-report"`,
		`"title": "Morning report"`,
		`"schedule": "0 9 * * *"`,
		`"timezone": "Asia/Tokyo"`,
		`"enabled": true`,
		"Summarize the overnight alerts.",
		"Two alerts, both resolved.",
		`"from_latest_run": false`,
		`"run_finished_at": "2026-11-20T00:01:30Z"`,
		"EARLIER run that finished at 2026-11-20T00:01:30Z",
		"A newer run (started at 2026-11-21T00:00:00Z) is failed",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("request lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "provider timeout") {
		t.Fatalf("request carries the failed run's error:\n%s", text)
	}
	if strings.Count(text, "Two alerts, both resolved.") != 1 {
		t.Fatalf("duplicate reference expanded twice:\n%s", text)
	}
	// The references are data beside the task: a user message of its own before the task, and
	// not part of the system prompt, which holds the instructions.
	if strings.Contains(request.Messages[0].Content, "Job references") || strings.Contains(request.Messages[0].Content, "Two alerts") {
		t.Fatal("system prompt carries the job references")
	}
	last := request.Messages[len(request.Messages)-1]
	if last.Role != "user" || last.Content != task {
		t.Fatalf("last message = %#v", last)
	}
	note := request.Messages[len(request.Messages)-2]
	if note.Role != "user" || !strings.HasPrefix(note.Content, "[Job references: read-only source data]") {
		t.Fatalf("note message = %#v", note)
	}
}

// A reference that cannot be used stops the run before a client exists or a prompt is built, for
// every reason alike.
func TestRunStopsBeforeAnyModelCallOnUnusableReference(t *testing.T) {
	group := audience.Conversation("tg:-100")
	group.SpeakerIsOwner = true
	cases := []struct {
		name string
		ctx  context.Context
		id   string
	}{
		{"unknown job", ownerContext(), "job-missing"},
		{"deleted one-time job", ownerContext(), "job-once"},
		{"contact", audience.NewContext(context.Background(), audience.Contact("tg:42")), "job-private"},
		{"group chat, the owner speaking", audience.NewContext(context.Background(), group), "job-private"},
		{"no audience", context.Background(), "job-private"},
	}
	var refusal string
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newJobReferenceRuntime(t,
				cronstore.Task{ID: "job-private", Cron: "0 9 * * *", Content: "PRIVATE PAYROLL"},
				cronstore.Task{ID: "job-once", At: "2031-01-02 09:00", Content: "ONE TIME BODY"},
			)
			env.recordRun(t, "job-private", time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC), daemonruntime.TaskDone, "PRIVATE RESULT")
			env.recordRun(t, "job-once", time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC), daemonruntime.TaskDone, "ONE TIME RESULT")
			// The one-time job ran and was deleted, as the scheduler deletes it; its run stays.
			if _, err := env.jobs.DeleteByID("job-once"); err != nil {
				t.Fatal(err)
			}
			before, revision, err := env.jobs.Snapshot(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			result, err := env.rt.Run(tc.ctx, RunRequest{Task: "Read [x](job:" + tc.id + ") and tell me"})
			if !errors.Is(err, jobrefs.ErrUnavailable) {
				t.Fatalf("Run() error = %v", err)
			}
			if result.Final != nil || len(env.client.requests) != 0 || env.clients != 0 || env.promptSpecs != 0 {
				t.Fatalf("final = %#v, requests = %d, clients = %d, prompt builds = %d", result.Final, len(env.client.requests), env.clients, env.promptSpecs)
			}
			message := strings.ReplaceAll(err.Error(), tc.id, "<id>")
			if refusal == "" {
				refusal = message
			}
			if message != refusal {
				t.Fatalf("refusal differs:\n%s\n%s", message, refusal)
			}
			for _, leak := range []string{"PRIVATE", "ONE TIME"} {
				if strings.Contains(err.Error(), leak) {
					t.Fatalf("refusal leaks %q: %v", leak, err)
				}
			}
			after, afterRevision, err := env.jobs.Snapshot(context.Background())
			if err != nil || afterRevision != revision || !reflect.DeepEqual(after, before) {
				t.Fatalf("jobs changed: %v, revision %d -> %d", err, revision, afterRevision)
			}
			if live := cronstore.Runs(env.jobs.Path); len(live) != 0 {
				t.Fatalf("executions started: %#v", live)
			}
		})
	}
}

func TestRunReferenceWithoutUsableOutputContinues(t *testing.T) {
	job := cronstore.Task{ID: "job-1", Cron: "0 9 * * *", Content: "Report the numbers"}
	cases := []struct {
		name   string
		setup  func(t *testing.T, env *jobReferenceRuntime)
		reason string
	}{
		{"never run", func(*testing.T, *jobReferenceRuntime) {}, jobrefs.ReasonNeverRun},
		// The job ran and ended done, by its own record, and the run store no longer holds the run
		// (its records were rotated away, or this is another state folder).
		{"output removed", func(t *testing.T, env *jobReferenceRuntime) {
			env.recordRun(t, "job-1", time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC), daemonruntime.TaskDone, "REMOVED OUTPUT")
			if err := env.jobs.RecordRunStart("job-1", time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)); err != nil {
				t.Fatal(err)
			}
			if err := env.jobs.RecordRunResult("job-1", cronstore.RunStatusDone); err != nil {
				t.Fatal(err)
			}
			emptied, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			env.rt.JobRuns = emptied
		}, jobrefs.ReasonNoFinishedOutput},
		{"no run store", func(_ *testing.T, env *jobReferenceRuntime) { env.rt.JobRuns = nil }, jobrefs.ReasonStorageUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newJobReferenceRuntime(t, job)
			tc.setup(t, env)
			if _, err := env.rt.Run(ownerContext(), RunRequest{Task: "Use [n](job:job-1)"}); err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if len(env.client.requests) != 1 {
				t.Fatalf("requests = %d", len(env.client.requests))
			}
			text := requestText(env.client.requests[0])
			for _, want := range []string{"Report the numbers", `"available": false`, `"reason": "` + tc.reason + `"`, "No result is available", "not as empty or successful"} {
				if !strings.Contains(text, want) {
					t.Fatalf("request lacks %q:\n%s", want, text)
				}
			}
			if strings.Contains(text, "REMOVED OUTPUT") || strings.Contains(text, `"output":`) {
				t.Fatalf("request carries an output:\n%s", text)
			}
		})
	}
}

// The user's own text is where references are read: a quoted message a channel adds to the task
// names no job for the run.
func TestRunReadsReferencesFromReferenceText(t *testing.T) {
	env := newJobReferenceRuntime(t, cronstore.Task{ID: "job-1", Cron: "0 9 * * *", Content: "JOB BODY"})
	_, err := env.rt.Run(ownerContext(), RunRequest{
		Task:          "> quoted: [x](job:job-missing)\n\nwhat is this?",
		ReferenceText: "what is this?",
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if text := requestText(env.client.requests[0]); strings.Contains(text, "Job references") {
		t.Fatalf("quoted reference was resolved:\n%s", text)
	}
}

// A caller that resolved the references before its own precheck hands them to the run, which
// reads nothing again; a resumed run reads nothing either.
func TestRunUsesReferencesTheCallerResolved(t *testing.T) {
	env := newJobReferenceRuntime(t, cronstore.Task{ID: "job-1", Cron: "0 9 * * *", Content: "FIRST BODY"})
	task := "Use [n](job:job-1)"
	resolved, err := env.rt.ResolveJobReferences(ownerContext(), task, nil, 0)
	if err != nil || resolved == nil || len(resolved.Jobs) != 1 {
		t.Fatalf("ResolveJobReferences: %#v, %v", resolved, err)
	}
	// The job changes, then is deleted, after the task started: the run keeps what it started with.
	if _, err := env.jobs.DeleteByID("job-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := env.rt.Run(ownerContext(), RunRequest{Task: task, JobReferences: resolved}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if text := requestText(env.client.requests[0]); !strings.Contains(text, "FIRST BODY") {
		t.Fatalf("request lacks the resolved job:\n%s", text)
	}
	// Without them the same run now fails, and a resume of it does not: it reads no reference.
	if _, err := env.rt.Run(ownerContext(), RunRequest{Task: task}); !errors.Is(err, jobrefs.ErrUnavailable) {
		t.Fatalf("Run() error = %v", err)
	}
	if _, err := env.rt.Resume(ownerContext(), "approval-missing", RunRequest{Task: task}); errors.Is(err, jobrefs.ErrUnavailable) {
		t.Fatalf("Resume() resolved the references again: %v", err)
	}

	local := jobrefs.Requester{LocalOwner: true}
	other := newJobReferenceRuntime(t, cronstore.Task{ID: "job-1", Cron: "0 9 * * *", Content: "CLI BODY"})
	if _, err := other.rt.Run(context.Background(), RunRequest{Task: task, JobReferenceRequester: &local}); err != nil {
		t.Fatalf("Run() as the local owner: %v", err)
	}
	if text := requestText(other.client.requests[0]); !strings.Contains(text, "CLI BODY") {
		t.Fatalf("request lacks the job:\n%s", text)
	}
}

// A subtask's text is written by a model: a reference in it is left as text.
func TestSubtaskDoesNotResolveJobReferences(t *testing.T) {
	env := newJobReferenceRuntime(t, cronstore.Task{ID: "job-1", Cron: "0 9 * * *", Content: "JOB BODY"})
	_, ctx, _ := agent.PrepareSubtaskContext(ownerContext(), nil)
	if agent.SubtaskDepthFromContext(ctx) == 0 {
		t.Skip("subtask context carries no depth")
	}
	if _, err := env.rt.Run(ctx, RunRequest{Task: "Use [n](job:job-1) and [m](job:job-missing)", DisableRuntimeTools: true}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if text := requestText(env.client.requests[0]); strings.Contains(text, "Job references") || strings.Contains(text, "JOB BODY") {
		t.Fatalf("subtask resolved a reference:\n%s", text)
	}
}

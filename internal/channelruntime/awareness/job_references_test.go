package awareness

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/awarenessutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/jobrefs"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// jobReferenceClient answers each run with an output made from its task, and keeps the requests.
type jobReferenceClient struct {
	mu       sync.Mutex
	requests []llm.Request
}

func (c *jobReferenceClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, req)
	task := req.Messages[len(req.Messages)-1].Content
	output := "OUTPUT OF: " + strings.ReplaceAll(strings.ReplaceAll(task, `"`, "'"), "\n", " ")
	return llm.Result{Text: `{"type":"final","output":"` + output + `"}`}, nil
}

func (c *jobReferenceClient) seen() []llm.Request {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]llm.Request(nil), c.requests...)
}

// runsOf counts the model requests whose task is content: the runs of the job with that content.
func (c *jobReferenceClient) runsOf(content string) int {
	count := 0
	for _, req := range c.seen() {
		if req.Messages[len(req.Messages)-1].Content == content {
			count++
		}
	}
	return count
}

func jobReferenceRequestText(req llm.Request) string {
	var b strings.Builder
	for _, message := range req.Messages[1:] {
		b.WriteString(message.Role + ": " + message.Content + "\n")
	}
	return b.String()
}

type jobReferenceLoop struct {
	t           *testing.T
	cronPath    string
	client      *jobReferenceClient
	taskStore   *awarenessTaskRecordStore
	requests    chan CronRequest
	promptSpecs int
}

// startJobReferenceLoop runs the awareness loop with its cron loop, as a runtime does.
func startJobReferenceLoop(t *testing.T, tasks ...cronstore.Task) *jobReferenceLoop {
	t.Helper()
	dir := t.TempDir()
	h := &jobReferenceLoop{
		t:         t,
		cronPath:  filepath.Join(dir, "cron.yaml"),
		client:    &jobReferenceClient{},
		taskStore: &awarenessTaskRecordStore{MemoryStore: daemonruntime.NewMemoryStore(50)},
		requests:  make(chan CronRequest),
	}
	for _, task := range tasks {
		seedTask(t, h.cronPath, task)
	}
	var mu sync.Mutex
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, depsutil.CommonDependencies{
			Logger: func() (*slog.Logger, error) { return slog.New(slog.DiscardHandler), nil },
			ResolveLLMRoute: func(purpose string) (llmutil.ResolvedRoute, error) {
				return llmutil.ResolvedRoute{Purpose: purpose, ClientConfig: llmconfig.ClientConfig{Provider: "test", Model: "m"}}, nil
			},
			CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return h.client, nil },
			PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
				mu.Lock()
				h.promptSpecs++
				mu.Unlock()
				return agent.DefaultPromptSpec(), nil, nil
			},
			AwarenessRegistry: func() *tools.Registry { return tools.NewRegistry() },
		}, RunOptions{
			DisableHeartbeat:    true,
			CronEnabled:         true,
			CronPath:            h.cronPath,
			CronRequests:        h.requests,
			ChatInfoStateDir:    dir,
			ChatInfoContactsDir: filepath.Join(dir, "contacts"),
			TaskStore:           h.taskStore,
			AgentLimits:         agent.Limits{MaxSteps: 1},
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("awareness loop did not stop")
		}
	})
	return h
}

// run starts the stored job id as its schedule would and waits for the run to end; it returns the
// run's record.
func (h *jobReferenceLoop) run(id string) daemonruntime.TaskInfo {
	h.t.Helper()
	task := storedTask(h.t, h.cronPath, id)
	before := len(cronstore.FinishedRuns(h.cronPath))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := TriggerCron(ctx, h.requests, task); err != nil {
		h.t.Fatal(err)
	}
	waitFor(h.t, id+" to end", func() bool { return len(cronstore.FinishedRuns(h.cronPath)) > before })
	records := h.taskStore.List(daemonruntime.TaskListOptions{TopicID: daemonruntime.CronTopicID(id), Limit: 1})
	if len(records) != 1 {
		h.t.Fatalf("%s has no run record", id)
	}
	return records[0]
}

func (h *jobReferenceLoop) lastRequest() string {
	h.t.Helper()
	requests := h.client.seen()
	if len(requests) == 0 {
		h.t.Fatal("no model request")
	}
	return jobReferenceRequestText(requests[len(requests)-1])
}

// A scheduled job that references another gets that job's definition and the output of its latest
// finished run, read from the run records; the referenced job is not run for it, nor changed.
func TestScheduledRunReadsReferencedJob(t *testing.T) {
	report := cronstore.Task{ID: "job-report", Title: "Morning report", Cron: "0 9 * * *", TZ: "UTC", Content: "List the overnight alerts."}
	digest := cronstore.Task{ID: "job-digest", Title: "Digest", Cron: "0 10 * * *", TZ: "UTC", ChatID: cronstore.ConsoleNotificationChatID,
		Content: "Write a digest from [Morning report](job:job-report) and [the same](job:job-report)."}
	h := startJobReferenceLoop(t, report, digest)

	// The report has never run: the digest still runs, told that there is no result.
	if got := h.run("job-digest"); got.Status != daemonruntime.TaskDone {
		t.Fatalf("digest run = %+v", got)
	}
	text := h.lastRequest()
	for _, want := range []string{"[Job references: read-only source data]", "List the overnight alerts.", `"reason": "never_run"`, "No result is available"} {
		if !strings.Contains(text, want) {
			t.Fatalf("request lacks %q:\n%s", want, text)
		}
	}
	if h.client.runsOf(report.Content) != 0 {
		t.Fatal("the reference ran the report")
	}

	if got := h.run("job-report"); got.Status != daemonruntime.TaskDone {
		t.Fatalf("report run = %+v", got)
	}
	jobsBefore, revision, err := cronstore.NewStore(h.cronPath).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	reportRecord := h.taskStore.List(daemonruntime.TaskListOptions{TopicID: daemonruntime.CronTopicID("job-report"), Limit: 1})[0]

	if got := h.run("job-digest"); got.Status != daemonruntime.TaskDone {
		t.Fatalf("digest run = %+v", got)
	}
	text = h.lastRequest()
	for _, want := range []string{
		`"id": "job-report"`, `"title": "Morning report"`, `"schedule": "0 9 * * *"`, `"timezone": "UTC"`, `"enabled": true`,
		"OUTPUT OF: List the overnight alerts.",
		`"from_latest_run": true`,
		`"run_finished_at": "` + reportRecord.FinishedAt.UTC().Format(time.RFC3339) + `"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("request lacks %q:\n%s", want, text)
		}
	}
	if strings.Count(text, "OUTPUT OF: List the overnight alerts.") != 1 {
		t.Fatalf("duplicate reference expanded twice:\n%s", text)
	}
	// The report ran once, when it was started, and never for the references to it.
	if got := h.client.runsOf(report.Content); got != 1 {
		t.Fatalf("report runs = %d, want 1", got)
	}
	if got := len(h.taskStore.List(daemonruntime.TaskListOptions{TopicID: daemonruntime.CronTopicID("job-report"), Limit: 10})); got != 1 {
		t.Fatalf("report run records = %d, want 1", got)
	}
	jobsAfter, afterRevision, err := cronstore.NewStore(h.cronPath).Snapshot(context.Background())
	if err != nil || afterRevision != revision {
		t.Fatalf("job list revision %d -> %d (%v)", revision, afterRevision, err)
	}
	for i := range jobsAfter {
		// The digest's own run marks move with its run; the referenced job is untouched.
		if jobsAfter[i].ID == "job-report" && !reflect.DeepEqual(jobsAfter[i], jobsBefore[i]) {
			t.Fatalf("report changed:\n%#v\n%#v", jobsBefore[i], jobsAfter[i])
		}
	}

	// Renamed and rewritten, the job is still the one the ID names.
	title, content := "Night watch", "List the alerts since midnight."
	if _, err := cronstore.NewStore(h.cronPath).Update(context.Background(), "job-report", cronstore.TaskPatch{Title: &title, Content: &content}); err != nil {
		t.Fatal(err)
	}
	h.run("job-digest")
	if text = h.lastRequest(); !strings.Contains(text, `"title": "Night watch"`) || !strings.Contains(text, "List the alerts since midnight.") {
		t.Fatalf("request lacks the renamed job:\n%s", text)
	}
}

// A reference the job may not use fails its run before a prompt is built or a model asked, and
// the run's record says why in words that are safe to show.
func TestScheduledRunStopsOnUnusableReference(t *testing.T) {
	private := cronstore.Task{ID: "job-private", Cron: "0 9 * * *", TZ: "UTC", Content: "PRIVATE PAYROLL", ChatID: cronstore.ConsoleNotificationChatID}
	sameGroup := cronstore.Task{ID: "job-group", Cron: "0 9 * * *", TZ: "UTC", Content: "GROUP STANDUP NOTES", ChatID: "tg:-100"}
	cases := []struct {
		name string
		job  cronstore.Task
		ok   bool
	}{
		{"unknown job", cronstore.Task{ID: "job-a", Cron: "0 10 * * *", TZ: "UTC", Content: "Use [x](job:job-missing)"}, false},
		{"group job, private job", cronstore.Task{ID: "job-a", Cron: "0 10 * * *", TZ: "UTC", ChatID: "tg:-100", Content: "Post [x](job:job-private) here"}, false},
		{"group job, job of the same group", cronstore.Task{ID: "job-a", Cron: "0 10 * * *", TZ: "UTC", ChatID: "tg:-100", Content: "Post [x](job:job-group) here"}, true},
		{"one-time job, deleted reference", cronstore.Task{ID: "job-a", At: "2031-01-02 09:00", TZ: "UTC", Content: "Use [x](job:job-gone)"}, false},
	}
	var refusal string
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := startJobReferenceLoop(t, private, sameGroup, tc.job)
			record := h.run("job-a")
			if tc.ok {
				if record.Status != daemonruntime.TaskDone || !strings.Contains(h.lastRequest(), "GROUP STANDUP NOTES") {
					t.Fatalf("record = %+v", record)
				}
				return
			}
			if record.Status != daemonruntime.TaskFailed || !strings.Contains(record.Error, "is not a job that can be referenced here") {
				t.Fatalf("record = %+v", record)
			}
			if len(h.client.seen()) != 0 || h.promptSpecs != 0 {
				t.Fatalf("model requests = %d, prompt builds = %d", len(h.client.seen()), h.promptSpecs)
			}
			id := jobrefs.ExtractIDs(tc.job.Content)[0]
			message := strings.ReplaceAll(record.Error, id, "<id>")
			if refusal == "" {
				refusal = message
			}
			if message != refusal || strings.Contains(record.Error, "PAYROLL") || strings.Contains(record.Error, "console:user") {
				t.Fatalf("refusal = %q, first = %q", record.Error, refusal)
			}
			// The job stays as it was (a one-time job is deleted only by a run that succeeds), and
			// its last run is marked failed.
			stored := storedTask(t, h.cronPath, "job-a")
			if stored.LastRunStatus != cronstore.RunStatusFailed || stored.Content != tc.job.Content {
				t.Fatalf("stored = %+v", stored)
			}
		})
	}
}

// A job that references itself, and a pair that reference each other, read one level: each run
// gets the other job's (or its own previous) output as text and follows nothing inside it.
func TestScheduledRunSelfAndCyclicReferences(t *testing.T) {
	a := cronstore.Task{ID: "job-a", Cron: "0 9 * * *", TZ: "UTC", Content: "A continues [itself](job:job-a) with [b](job:job-b)."}
	b := cronstore.Task{ID: "job-b", Cron: "0 9 * * *", TZ: "UTC", Content: "B answers [a](job:job-a)."}
	h := startJobReferenceLoop(t, a, b)

	first := h.run("job-a")
	if first.Status != daemonruntime.TaskDone || len(h.client.seen()) != 1 {
		t.Fatalf("first run = %+v, requests = %d", first, len(h.client.seen()))
	}
	// Its own run in progress is not its "latest result": it has none yet.
	text := h.lastRequest()
	if strings.Count(text, `"reason": "never_run"`) != 2 || strings.Contains(text, `"status": "running"`) {
		t.Fatalf("first run:\n%s", text)
	}

	h.run("job-b")
	h.run("job-a")
	if got := len(h.client.seen()); got != 3 {
		t.Fatalf("model requests = %d, want 3 (one per started run)", got)
	}
	text = h.lastRequest()
	// A's second run reads A's first output and B's output, each once. B's output quotes A's
	// reference text, which stays text.
	if strings.Count(text, `"id": "job-a"`) != 1 || strings.Count(text, `"id": "job-b"`) != 1 {
		t.Fatalf("second run:\n%s", text)
	}
	firstFinished := first.FinishedAt.UTC().Format(time.RFC3339)
	if !strings.Contains(text, `"run_finished_at": "`+firstFinished+`"`) || !strings.Contains(text, "OUTPUT OF: B answers [a](job:job-a).") {
		t.Fatalf("second run:\n%s", text)
	}
}

// A heartbeat follows the owner's checklist and may reference jobs; a poke's text comes from
// outside and may not.
func TestHeartbeatAndPokeJobReferences(t *testing.T) {
	cronPath := filepath.Join(t.TempDir(), "cron.yaml")
	seedTask(t, cronPath, cronstore.Task{ID: "job-1", Cron: "0 9 * * *", TZ: "UTC", Content: "CHECKLIST JOB BODY"})
	run := func(behavior awarenessutil.Behavior) (*awarenessPromptCaptureClient, error) {
		client := &awarenessPromptCaptureClient{}
		_, err := runAwarenessTask(context.Background(), depsutil.CommonDependencies{
			PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
				return agent.PromptSpec{Identity: "identity"}, nil, nil
			},
		}, awarenessTaskOptions{
			Behavior:     behavior,
			Client:       client,
			Model:        "test-model",
			Task:         "Check [the job](job:job-1) and report.",
			BaseRegistry: tools.NewRegistry(),
			Config:       agent.Config{MaxSteps: 1},
			CronPath:     cronPath,
		})
		return client, err
	}
	client, err := run(awarenessutil.BehaviorHeartbeat)
	if err != nil || len(client.requests) != 1 {
		t.Fatalf("heartbeat: %v, requests = %d", err, len(client.requests))
	}
	text := jobReferenceRequestText(client.requests[0])
	// A heartbeat keeps no run store of jobs here: the definition comes with the note.
	if !strings.Contains(text, "CHECKLIST JOB BODY") || !strings.Contains(text, `"reason": "storage_unavailable"`) {
		t.Fatalf("heartbeat request:\n%s", text)
	}
	client, err = run(awarenessutil.BehaviorPoke)
	if !errors.Is(err, jobrefs.ErrUnavailable) || len(client.requests) != 0 {
		t.Fatalf("poke: %v, requests = %d", err, len(client.requests))
	}
}

// doneRuns lists the done run records of job id, newest first.
func (h *jobReferenceLoop) doneRuns(id string) []daemonruntime.TaskInfo {
	var out []daemonruntime.TaskInfo
	for _, record := range h.taskStore.List(daemonruntime.TaskListOptions{TopicID: daemonruntime.CronTopicID(id), Limit: 20}) {
		if record.Status == daemonruntime.TaskDone {
			out = append(out, record)
		}
	}
	return out
}

// start starts the stored job id and waits until it has want done runs and the loop is idle.
func (h *jobReferenceLoop) start(id string, want int) {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := TriggerCron(ctx, h.requests, storedTask(h.t, h.cronPath, id)); err != nil {
		h.t.Fatal(err)
	}
	waitFor(h.t, id+" to end", func() bool { return len(h.doneRuns(id)) >= want && len(cronstore.Runs(h.cronPath)) == 0 })
}

// requestFor returns the latest model request of the job whose instructions are content.
func (h *jobReferenceLoop) requestFor(content string) string {
	h.t.Helper()
	requests := h.client.seen()
	for i := len(requests) - 1; i >= 0; i-- {
		if requests[i].Messages[len(requests[i].Messages)-1].Content == content {
			return jobReferenceRequestText(requests[i])
		}
	}
	h.t.Fatalf("no model request for %q", content)
	return ""
}

// A job is given the jobs it uses as references, with no link in its text: the output of the run
// that started it, or the latest output when something else started it. A link in the text alone
// is read and starts nothing.
func TestScheduledRunIsGivenTheJobsItUses(t *testing.T) {
	report := cronstore.Task{ID: "job-report", Title: "Morning report", Content: "List the overnight alerts.", Triggers: []cronstore.Trigger{}}
	digest := func(text string, uses ...cronstore.Use) cronstore.Task {
		return cronstore.Task{ID: "job-digest", Title: "Digest", Content: text, Triggers: []cronstore.Trigger{}, Uses: uses}
	}
	const reportOutput = "OUTPUT OF: List the overnight alerts."

	t.Run("started by a person before the used job ever ran", func(t *testing.T) {
		d := digest("Write the digest.", cronstore.Use{JobID: "job-report"})
		h := startJobReferenceLoop(t, report, d)
		h.start("job-digest", 1)
		text := h.requestFor(d.Content)
		for _, want := range []string{"[Job references: read-only source data]", `"input": true`, "List the overnight alerts.", `"reason": "never_run"`} {
			if !strings.Contains(text, want) {
				t.Fatalf("request lacks %q:\n%s", want, text)
			}
		}
		if h.client.runsOf(report.Content) != 0 {
			t.Fatal("running a job ran the job it uses")
		}
	})

	t.Run("linked and used is given once", func(t *testing.T) {
		d := digest("Write the digest of [the report](job:job-report).", cronstore.Use{JobID: "job-report"})
		h := startJobReferenceLoop(t, report, d)
		h.start("job-report", 1)
		waitFor(t, "the digest to run", func() bool { return len(h.doneRuns("job-digest")) == 1 && len(cronstore.Runs(h.cronPath)) == 0 })
		text := h.requestFor(d.Content)
		if strings.Count(text, `"id": "job-report"`) != 1 || strings.Count(text, reportOutput) != 1 || !strings.Contains(text, `"input": true`) {
			t.Fatalf("request:\n%s", text)
		}
	})

	t.Run("each finished run of the used job starts the job with that run's output", func(t *testing.T) {
		d := digest("Write the digest.", cronstore.Use{JobID: "job-report"})
		h := startJobReferenceLoop(t, report, d)
		h.start("job-report", 1)
		waitFor(t, "the digest to run", func() bool { return len(h.doneRuns("job-digest")) == 1 && len(cronstore.Runs(h.cronPath)) == 0 })
		reportRecord := h.doneRuns("job-report")[0]
		text := h.requestFor(d.Content)
		for _, want := range []string{`"input": true`, reportOutput, `"from_this_chain": true`,
			`"run_finished_at": "` + reportRecord.FinishedAt.UTC().Format(time.RFC3339) + `"`, "the run of this job that led to this run"} {
			if !strings.Contains(text, want) {
				t.Fatalf("request lacks %q:\n%s", want, text)
			}
		}
		// Started by a person, with no run of the input in its chain: the latest, said as such.
		h.start("job-digest", 2)
		text = h.requestFor(d.Content)
		if !strings.Contains(text, reportOutput) || strings.Contains(text, `"from_this_chain": true`) || !strings.Contains(text, "output of the job's latest run") {
			t.Fatalf("request:\n%s", text)
		}
		// The next finished run of the used job starts it again.
		h.start("job-report", 2)
		waitFor(t, "the digest to run again", func() bool { return len(h.doneRuns("job-digest")) == 3 && len(cronstore.Runs(h.cronPath)) == 0 })
	})

	t.Run("a link in the text alone is read and starts nothing", func(t *testing.T) {
		d := digest("Write the digest of [the report](job:job-report).")
		h := startJobReferenceLoop(t, report, d)
		h.start("job-report", 1)
		h.start("job-digest", 1)
		text := h.requestFor(d.Content)
		if !strings.Contains(text, reportOutput) || strings.Contains(text, `"input": true`) || strings.Contains(text, `"from_this_chain": true`) {
			t.Fatalf("request:\n%s", text)
		}
		runs, err := cronstore.NewStore(h.cronPath).RunHistory(context.Background(), cronstore.RunHistoryQuery{JobID: "job-digest"})
		if err != nil || len(runs) != 1 || runs[0].Cause.Kind != cronstore.CauseManual || h.client.runsOf(report.Content) != 1 {
			t.Fatalf("digest history = %+v, %v", runs, err)
		}
	})

	t.Run("a used job the job may not read fails the run", func(t *testing.T) {
		d := digest("Write the digest.", cronstore.Use{JobID: "job-report"})
		d.ChatID = "tg:-100"
		h := startJobReferenceLoop(t, report, d)
		record := h.run("job-digest")
		if record.Status != daemonruntime.TaskFailed || !strings.Contains(record.Error, "is not a job that can be referenced here") || len(h.client.seen()) != 0 {
			t.Fatalf("record = %+v", record)
		}
	})
}

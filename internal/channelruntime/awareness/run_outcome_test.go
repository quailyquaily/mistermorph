package awareness

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/awarenessutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// outcomeDecisionClient stands in for the decision route's client: it answers Evaluate and must
// never be asked to chat.
type outcomeDecisionClient struct {
	selected  string
	kind      llm.QuestionKind
	noAnswer  bool
	nilResult bool
	err       error
	// hold keeps the call open until its context ends.
	hold bool

	requests   []llm.EvaluateRequest
	chatCalls  int
	closeCalls int
}

func (c *outcomeDecisionClient) Chat(context.Context, llm.Request) (llm.Result, error) {
	c.chatCalls++
	return llm.Result{}, errors.New("the decision client must not chat")
}

func (c *outcomeDecisionClient) Evaluate(ctx context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	c.requests = append(c.requests, req)
	if c.hold {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if c.err != nil {
		return nil, c.err
	}
	if c.nilResult {
		return nil, nil
	}
	res := &llm.EvaluateResult{Answers: map[string]llm.Answer{}}
	if !c.noAnswer {
		kind := c.kind
		if kind == "" {
			kind = llm.Choice
		}
		res.Answers[daemonruntime.TaskResultOutcomeKey] = llm.Answer{Kind: kind, Selected: c.selected}
	}
	return res, nil
}

func (c *outcomeDecisionClient) Close() error {
	c.closeCalls++
	return nil
}

func TestClassifyRunOutcome(t *testing.T) {
	failure := errors.New("decision route unavailable")
	for _, tc := range []struct {
		name    string
		client  *outcomeDecisionClient
		want    string
		wantErr error
	}{
		{name: "result", client: &outcomeDecisionClient{selected: "result"}, want: daemonruntime.TaskOutcomeResult},
		{name: "nothing", client: &outcomeDecisionClient{selected: "nothing"}, want: daemonruntime.TaskOutcomeNothing},
		{name: "problem", client: &outcomeDecisionClient{selected: "problem"}, want: daemonruntime.TaskOutcomeProblem},
		{name: "an answer that is not an option", client: &outcomeDecisionClient{selected: "quiet"}, wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "an option in another case", client: &outcomeDecisionClient{selected: "Nothing"}, wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "an empty answer", client: &outcomeDecisionClient{selected: ""}, wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "an answer of another kind", client: &outcomeDecisionClient{selected: "nothing", kind: llm.Boolean}, wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "no answer", client: &outcomeDecisionClient{noAnswer: true}, wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "no result", client: &outcomeDecisionClient{nilResult: true}, wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "the call fails", client: &outcomeDecisionClient{err: failure}, wantErr: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := classifyRunOutcome(context.Background(), tc.client, " decision-model ", "Run a factory build.", "No build performed: new/ is empty.")
			if got != tc.want || !errors.Is(err, tc.wantErr) {
				t.Fatalf("classifyRunOutcome() = %q, %v; want %q, %v", got, err, tc.want, tc.wantErr)
			}
			if len(tc.client.requests) != 1 || tc.client.chatCalls != 0 {
				t.Fatalf("evaluate calls = %d, chat calls = %d; want one Evaluate", len(tc.client.requests), tc.client.chatCalls)
			}
			req := tc.client.requests[0]
			if req.Model != "decision-model" || req.Scene != "todo.run_outcome" {
				t.Fatalf("request model = %q, scene = %q", req.Model, req.Scene)
			}
			state, _ := req.State.(map[string]any)
			if state["task"] != "Run a factory build." || state["final_output"] != "No build performed: new/ is empty." {
				t.Fatalf("state = %#v", req.State)
			}
			question, ok := req.Questions["outcome"]
			if len(req.Questions) != 1 || !ok || question.Kind != llm.Choice || len(question.Options) != 3 {
				t.Fatalf("questions = %#v", req.Questions)
			}
			for _, option := range []string{"result", "nothing", "problem"} {
				if text, _ := question.Options[option].(string); strings.TrimSpace(text) == "" {
					t.Fatalf("option %q has no description: %#v", option, question.Options)
				}
			}
		})
	}

	t.Run("a client that cannot evaluate", func(t *testing.T) {
		got, err := classifyRunOutcome(context.Background(), &awarenessPromptCaptureClient{}, "m", "task", "output")
		if got != "" || !errors.Is(err, llm.ErrEvaluateUnsupported) {
			t.Fatalf("classifyRunOutcome() = %q, %v", got, err)
		}
	})
	t.Run("no client", func(t *testing.T) {
		got, err := classifyRunOutcome(context.Background(), nil, "m", "task", "output")
		if got != "" || !errors.Is(err, llm.ErrEvaluateUnsupported) {
			t.Fatalf("classifyRunOutcome() = %q, %v", got, err)
		}
	})
	t.Run("a long output keeps its start and its end", func(t *testing.T) {
		client := &outcomeDecisionClient{selected: "result"}
		output := "START " + strings.Repeat("x", 3*runOutcomeTextLimit) + " END"
		if _, err := classifyRunOutcome(context.Background(), client, "m", "task", output); err != nil {
			t.Fatal(err)
		}
		sent, _ := client.requests[0].State.(map[string]any)["final_output"].(string)
		if len([]rune(sent)) > runOutcomeTextLimit+16 || !strings.HasPrefix(sent, "START ") || !strings.HasSuffix(sent, " END") {
			t.Fatalf("clipped output: %d runes, %q ... %q", len([]rune(sent)), sent[:8], sent[len(sent)-8:])
		}
	})
}

// outcomeRunClient is a run's own client: it answers with a final output, fails, or ends the run
// as a person stopping it would.
type outcomeRunClient struct {
	output string
	err    error
	stop   context.CancelCauseFunc
}

func (c *outcomeRunClient) Chat(ctx context.Context, _ llm.Request) (llm.Result, error) {
	if c.stop != nil {
		c.stop(cronstore.ErrRunStopped)
		<-ctx.Done()
		return llm.Result{}, ctx.Err()
	}
	if c.err != nil {
		return llm.Result{}, c.err
	}
	return llm.Result{Text: `{"type":"final","output":"` + c.output + `"}`}, nil
}

func outcomeTestDeps() depsutil.CommonDependencies {
	return depsutil.CommonDependencies{
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.PromptSpec{Identity: "identity"}, nil, nil
		},
	}
}

func storedOutcome(t *testing.T, store daemonruntime.TaskView, id string) (daemonruntime.TaskInfo, string, bool) {
	t.Helper()
	info, ok := store.Get(id)
	if !ok || info == nil {
		t.Fatalf("task %q is not recorded", id)
	}
	result, _ := info.Result.(map[string]any)
	raw, has := result[daemonruntime.TaskResultOutcomeKey]
	outcome, _ := raw.(string)
	return *info, outcome, has
}

// Which runs are checked, and what the record keeps: only a run a TODO item's schedule fired that
// ended done, the answer beside the final output, and nothing when there is no answer. The run
// ends done whatever the check does.
func TestRunAwarenessTaskRecordsTheOutcomeOfScheduledRuns(t *testing.T) {
	failure := errors.New("decision route unavailable")
	type decision = outcomeDecisionClient
	for _, tc := range []struct {
		name        string
		behavior    awarenessutil.Behavior
		manual      bool
		decision    *decision
		runErr      error
		stopped     bool
		wantStatus  daemonruntime.TaskStatus
		wantOutcome string
		wantChecks  int
	}{
		{name: "scheduled, result", behavior: awarenessutil.BehaviorCron, decision: &decision{selected: "result"}, wantStatus: daemonruntime.TaskDone, wantOutcome: "result", wantChecks: 1},
		{name: "scheduled, nothing", behavior: awarenessutil.BehaviorCron, decision: &decision{selected: "nothing"}, wantStatus: daemonruntime.TaskDone, wantOutcome: "nothing", wantChecks: 1},
		{name: "scheduled, problem", behavior: awarenessutil.BehaviorCron, decision: &decision{selected: "problem"}, wantStatus: daemonruntime.TaskDone, wantOutcome: "problem", wantChecks: 1},
		{name: "scheduled, the decision route has no profile of its own", behavior: awarenessutil.BehaviorCron, wantStatus: daemonruntime.TaskDone},
		{name: "scheduled, the call fails", behavior: awarenessutil.BehaviorCron, decision: &decision{err: failure}, wantStatus: daemonruntime.TaskDone, wantChecks: 1},
		{name: "scheduled, an answer that is not an option", behavior: awarenessutil.BehaviorCron, decision: &decision{selected: "quiet"}, wantStatus: daemonruntime.TaskDone, wantChecks: 1},
		{name: "scheduled, no answer", behavior: awarenessutil.BehaviorCron, decision: &decision{noAnswer: true}, wantStatus: daemonruntime.TaskDone, wantChecks: 1},
		{name: "scheduled, no result", behavior: awarenessutil.BehaviorCron, decision: &decision{nilResult: true}, wantStatus: daemonruntime.TaskDone, wantChecks: 1},
		{name: "manual", behavior: awarenessutil.BehaviorCron, manual: true, decision: &decision{selected: "nothing"}, wantStatus: daemonruntime.TaskDone},
		{name: "heartbeat", behavior: awarenessutil.BehaviorHeartbeat, decision: &decision{selected: "nothing"}, wantStatus: daemonruntime.TaskDone},
		{name: "poke", behavior: awarenessutil.BehaviorPoke, decision: &decision{selected: "nothing"}, wantStatus: daemonruntime.TaskDone},
		{name: "scheduled, failed", behavior: awarenessutil.BehaviorCron, decision: &decision{selected: "nothing"}, runErr: errors.New("model unavailable"), wantStatus: daemonruntime.TaskFailed},
		{name: "scheduled, stopped", behavior: awarenessutil.BehaviorCron, decision: &decision{selected: "nothing"}, stopped: true, wantStatus: daemonruntime.TaskCanceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			ctx, stop := context.WithCancelCause(context.Background())
			defer stop(nil)
			runClient := &outcomeRunClient{output: "No build performed: new/ is empty.", err: tc.runErr}
			if tc.stopped {
				runClient.stop = stop
			}
			opts := awarenessTaskOptions{
				Behavior:     tc.behavior,
				Client:       runClient,
				Model:        "run-model",
				Task:         "Run a factory build.",
				TaskRunID:    "run:1",
				BaseRegistry: tools.NewRegistry(),
				Config:       agent.Config{MaxSteps: 1},
				TaskStore:    store,
				CronManual:   tc.manual,
			}
			if tc.behavior == awarenessutil.BehaviorCron {
				opts.TopicID, opts.TopicTitle = daemonruntime.CronTopicID("task-4"), "Factory build"
			}
			if tc.decision != nil {
				opts.DecisionClient, opts.DecisionModel = tc.decision, "decision-model"
			}
			summary, runErr := runAwarenessTask(ctx, outcomeTestDeps(), opts)
			if wantErr := tc.wantStatus != daemonruntime.TaskDone; (runErr != nil) != wantErr {
				t.Fatalf("runAwarenessTask() = %q, %v", summary, runErr)
			}
			info, outcome, has := storedOutcome(t, store, "run:1")
			if info.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q", info.Status, tc.wantStatus)
			}
			if outcome != tc.wantOutcome || has != (tc.wantOutcome != "") {
				t.Fatalf("stored outcome = %q (present %v), want %q; result = %#v", outcome, has, tc.wantOutcome, info.Result)
			}
			if tc.wantStatus == daemonruntime.TaskDone {
				final, _ := info.Result.(map[string]any)["final"].(map[string]any)
				if summary != "No build performed: new/ is empty." || final["output"] != summary {
					t.Fatalf("summary = %q, stored final = %#v", summary, final)
				}
			}
			if tc.decision != nil {
				if len(tc.decision.requests) != tc.wantChecks || tc.decision.chatCalls != 0 {
					t.Fatalf("checks = %d (chat calls %d), want %d", len(tc.decision.requests), tc.decision.chatCalls, tc.wantChecks)
				}
				if tc.wantChecks == 1 {
					state, _ := tc.decision.requests[0].State.(map[string]any)
					if state["task"] != "Run a factory build." || state["final_output"] != summary || tc.decision.requests[0].Model != "decision-model" {
						t.Fatalf("check request = %#v", tc.decision.requests[0])
					}
				}
			}
			// The Console tells a quiet run by the record alone.
			if got, want := daemonruntime.IsQuietTask(info), tc.wantOutcome == daemonruntime.TaskOutcomeNothing; got != want {
				t.Fatalf("IsQuietTask = %v, want %v", got, want)
			}
		})
	}
}

// A check that does not answer in time, or whose run's context ends while it waits, leaves the
// run done and unchecked.
func TestRunOutcomeCheckGivesUpWithoutFailingTheRun(t *testing.T) {
	for _, tc := range []struct {
		name string
		// cancelAfter ends the run's context this long into the check; zero leaves it to the
		// check's own time limit.
		cancelAfter time.Duration
		wantWait    time.Duration
	}{
		{name: "time limit", wantWait: runOutcomeTimeout},
		{name: "cancellation", cancelAfter: 2 * time.Second, wantWait: 2 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				store := &awarenessTaskRecordStore{MemoryStore: daemonruntime.NewMemoryStore(10)}
				decision := &outcomeDecisionClient{hold: true}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if tc.cancelAfter > 0 {
					time.AfterFunc(tc.cancelAfter, cancel)
				}
				started := time.Now()
				summary, err := runAwarenessTask(ctx, outcomeTestDeps(), awarenessTaskOptions{
					Behavior:       awarenessutil.BehaviorCron,
					Client:         &outcomeRunClient{output: "new/ is empty."},
					Model:          "run-model",
					Task:           "Run a factory build.",
					TaskRunID:      "run:held",
					BaseRegistry:   tools.NewRegistry(),
					Config:         agent.Config{MaxSteps: 1},
					TaskStore:      store,
					DecisionClient: decision,
				})
				if err != nil || summary != "new/ is empty." {
					t.Fatalf("runAwarenessTask() = %q, %v", summary, err)
				}
				if waited := time.Since(started); waited != tc.wantWait {
					t.Fatalf("the check held the run for %v, want %v", waited, tc.wantWait)
				}
				info, outcome, has := storedOutcome(t, store, "run:held")
				if info.Status != daemonruntime.TaskDone || has || outcome != "" || len(decision.requests) != 1 {
					t.Fatalf("status = %q, outcome = %q (present %v), checks = %d", info.Status, outcome, has, len(decision.requests))
				}
			})
		})
	}
}

func TestChecksRunOutcome(t *testing.T) {
	store := daemonruntime.NewMemoryStore(1)
	client := &outcomeDecisionClient{}
	base := awarenessTaskOptions{Behavior: awarenessutil.BehaviorCron, DecisionClient: client, TaskStore: store, TaskRunID: "run"}
	for _, tc := range []struct {
		name string
		edit func(*awarenessTaskOptions)
		want bool
	}{
		{"scheduled TODO run", func(*awarenessTaskOptions) {}, true},
		{"manual TODO run", func(o *awarenessTaskOptions) { o.CronManual = true }, false},
		{"heartbeat", func(o *awarenessTaskOptions) { o.Behavior = awarenessutil.BehaviorHeartbeat }, false},
		{"no decision client", func(o *awarenessTaskOptions) { o.DecisionClient = nil }, false},
		{"no record", func(o *awarenessTaskOptions) { o.TaskStore = nil }, false},
		{"no run ID", func(o *awarenessTaskOptions) { o.TaskRunID = " " }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := base
			tc.edit(&opts)
			if got := checksRunOutcome(opts); got != tc.want {
				t.Fatalf("checksRunOutcome = %v, want %v", got, tc.want)
			}
			// An unchecked run asks nothing; so does a run without output.
			before := len(client.requests)
			_ = finishedRunOutcome(context.Background(), opts, "task", " ")
			if !tc.want {
				_ = finishedRunOutcome(context.Background(), opts, "task", "output")
			}
			if len(client.requests) != before {
				t.Fatalf("the decision route was asked %d times", len(client.requests)-before)
			}
		})
	}
}

// The check gets the decision route's own client, and none when that route has no profile of its
// own: the main route is never asked in its place.
func TestNewRunOutcomeClient(t *testing.T) {
	route := func(purpose, profile string) llmutil.ResolvedRoute {
		return llmutil.ResolvedRoute{Purpose: purpose, Profile: profile, ClientConfig: llmconfig.ClientConfig{Provider: "test", Model: profile + "-model"}}
	}
	failure := errors.New("no such profile")
	for _, tc := range []struct {
		name        string
		decision    string
		resolveErr  error
		createErr   error
		wantClient  bool
		wantCreated int
	}{
		{name: "its own profile", decision: "small", wantClient: true, wantCreated: 1},
		{name: "the main route's profile", decision: "main"},
		{name: "the route does not resolve", decision: "small", resolveErr: failure},
		{name: "the client cannot be made", decision: "small", createErr: failure, wantCreated: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &outcomeDecisionClient{}
			var created []llmutil.ResolvedRoute
			decorated := 0
			deps := depsutil.CommonDependencies{
				ResolveLLMRoute: func(purpose string) (llmutil.ResolvedRoute, error) {
					if purpose == llmutil.RoutePurposeDecision {
						return route(purpose, tc.decision), tc.resolveErr
					}
					return route(purpose, "main"), nil
				},
				CreateLLMClient: func(r llmutil.ResolvedRoute) (llm.Client, error) {
					created = append(created, r)
					if tc.createErr != nil {
						return client, tc.createErr
					}
					return client, nil
				},
			}
			got, model, closeClient := newRunOutcomeClient(deps, func(c llm.Client, _ llmutil.ResolvedRoute) llm.Client {
				decorated++
				return c
			}, slog.New(slog.DiscardHandler))
			if (got != nil) != tc.wantClient || len(created) != tc.wantCreated {
				t.Fatalf("client = %v, created = %d; want client %v, created %d", got, len(created), tc.wantClient, tc.wantCreated)
			}
			for _, r := range created {
				if r.Purpose != llmutil.RoutePurposeDecision {
					t.Fatalf("a client was made for the %q route", r.Purpose)
				}
			}
			if tc.wantClient {
				if model != "small-model" || decorated != 1 {
					t.Fatalf("model = %q, decorated = %d", model, decorated)
				}
				if err := closeClient(); err != nil || client.closeCalls != 1 {
					t.Fatalf("close = %v, calls = %d", err, client.closeCalls)
				}
				return
			}
			if model != "" || decorated != 0 {
				t.Fatalf("model = %q, decorated = %d without a client", model, decorated)
			}
			if err := closeClient(); err != nil {
				t.Fatal(err)
			}
			// A client returned beside a creation error is closed at once, and only then.
			if want := map[bool]int{true: 1, false: 0}[tc.createErr != nil]; client.closeCalls != want {
				t.Fatalf("close calls = %d, want %d", client.closeCalls, want)
			}
		})
	}
}

// Through the loop: a run the item's schedule fires is checked on the decision route's own
// client, which the loop makes once and closes when it ends; a run a person asks for is not.
func TestAwarenessLoopChecksScheduledTodoRuns(t *testing.T) {
	dir := t.TempDir()
	cronPath := filepath.Join(dir, "cron.yaml")
	task := cronstore.Task{ID: "build", Title: "Factory build", Cron: "* * * * *", TZ: "UTC", Content: "Run a factory build."}
	seedTask(t, cronPath, task)
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	decision := &outcomeDecisionClient{selected: "nothing"}
	var (
		mu      sync.Mutex
		created = map[string]int{}
	)
	requests := make(chan CronRequest)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, depsutil.CommonDependencies{
			Logger: func() (*slog.Logger, error) { return slog.New(slog.DiscardHandler), nil },
			ResolveLLMRoute: func(purpose string) (llmutil.ResolvedRoute, error) {
				profile := "main"
				if purpose == llmutil.RoutePurposeDecision {
					profile = "small"
				}
				return llmutil.ResolvedRoute{Purpose: purpose, Profile: profile, ClientConfig: llmconfig.ClientConfig{Provider: "test", Model: profile + "-model"}}, nil
			},
			CreateLLMClient: func(route llmutil.ResolvedRoute) (llm.Client, error) {
				mu.Lock()
				created[route.Purpose]++
				mu.Unlock()
				if route.Purpose == llmutil.RoutePurposeDecision {
					return decision, nil
				}
				return &outcomeRunClient{output: "No build performed: new/ is empty."}, nil
			},
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
			TaskStore:           store,
		})
	}()
	stopped := false
	stopLoop := func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Run() error = %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("awareness loop did not stop")
		}
	}
	defer stopLoop()

	topic := daemonruntime.CronTopicID(task.ID)
	finished := func() []daemonruntime.TaskInfo {
		var out []daemonruntime.TaskInfo
		for _, info := range store.List(daemonruntime.TaskListOptions{Limit: 10, TopicID: topic}) {
			if info.Status == daemonruntime.TaskDone {
				out = append(out, info)
			}
		}
		return out
	}
	// The schedule fires the item as the loop starts.
	waitFor(t, "the scheduled run to end", func() bool { return len(finished()) == 1 })
	scheduled := finished()[0]
	if got := daemonruntime.TaskOutcome(scheduled); got != daemonruntime.TaskOutcomeNothing || !daemonruntime.IsQuietTask(scheduled) {
		t.Fatalf("scheduled run's outcome = %q; result = %#v", got, scheduled.Result)
	}
	if trigger, _ := store.GetTrigger(scheduled.ID); trigger.Ref != daemonruntime.CronRunTriggerRefSchedule {
		t.Fatalf("scheduled run's trigger = %+v", trigger)
	}

	waitFor(t, "the item to be free again", func() bool { _, running := currentRun(cronPath, task.ID); return !running })
	triggerCtx, triggerCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer triggerCancel()
	if err := TriggerCron(triggerCtx, requests, task); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the manual run to end", func() bool { return len(finished()) == 2 })
	for _, info := range finished() {
		if info.ID == scheduled.ID {
			continue
		}
		if trigger, _ := store.GetTrigger(info.ID); trigger.Ref != daemonruntime.CronRunTriggerRefManual {
			t.Fatalf("manual run's trigger = %+v", trigger)
		}
		if got := daemonruntime.TaskOutcome(info); got != "" {
			t.Fatalf("manual run's outcome = %q, want none", got)
		}
	}
	stopLoop()
	mu.Lock()
	defer mu.Unlock()
	if len(decision.requests) != 1 || decision.chatCalls != 0 || created[llmutil.RoutePurposeDecision] != 1 || decision.closeCalls != 1 {
		t.Fatalf("checks = %d, chat calls = %d, decision clients made = %d, closed = %d", len(decision.requests), decision.chatCalls, created[llmutil.RoutePurposeDecision], decision.closeCalls)
	}
}

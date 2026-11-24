package integration

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	discordruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/discord"
	mixinruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/mixin"
	slackruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/slack"
	telegramruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/telegram"
	wechatruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/wechat"
	whatsappruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/whatsapp"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/jobtriggers"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/mcphost"
	"github.com/quailyquaily/mistermorph/llm"
)

const jobsTestWait = 20 * time.Second

// jobsHarness is a runtime with a scripted model and fake channel runtimes: each fake records the
// options its bot was started with and runs until its context ends.
type jobsHarness struct {
	t        *testing.T
	rt       *Runtime
	stateDir string
	cronPath string

	mu       sync.Mutex
	prompts  []string
	started  map[string]chan jobHooks
	failMCP  error
	mcpConns int
	mcpClose int
}

func jobsTestConfig(t *testing.T) Config {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Features.Skills = false
	cfg.Set("file_state_dir", t.TempDir())
	cfg.Set("file_cache_dir", t.TempDir())
	cfg.Set("llm.provider", "openai")
	cfg.Set("llm.api_key", "test")
	cfg.Set("llm.model", "main-model")
	cfg.Set("heartbeat.enabled", false)
	cfg.Set("guard.enabled", false)
	return cfg
}

func newJobsHarness(t *testing.T, cfg Config) *jobsHarness {
	t.Helper()
	h := &jobsHarness{t: t, started: map[string]chan jobHooks{}}
	for _, name := range []string{"telegram", "slack", "mixin", "discord", "wechat", "whatsapp"} {
		h.started[name] = make(chan jobHooks, 8)
	}
	h.rt = newRuntime(cfg, runtimeBuildDependencies{
		buildClient: func(llmconfig.ClientConfig, llmutil.RuntimeValues) (llm.Client, error) {
			return &stubIntegrationLLMClient{chatFn: h.chat}, nil
		},
		connectMCP: func(context.Context, []mcphost.ServerConfig, *slog.Logger) (mcpRegistration, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.failMCP != nil {
				return mcpRegistration{}, h.failMCP
			}
			h.mcpConns++
			return mcpRegistration{close: func() error {
				h.mu.Lock()
				h.mcpClose++
				h.mu.Unlock()
				return nil
			}}, nil
		},
		channels: channelRunners{
			telegram: func(ctx context.Context, _ telegramruntime.Dependencies, opts telegramruntime.RunOptions) error {
				return h.fakeBot(ctx, "telegram", jobHooks{Poke: opts.Server.Poke, CronRun: opts.Server.CronRun, Triggers: opts.JobTriggers})
			},
			slack: func(ctx context.Context, _ slackruntime.Dependencies, opts slackruntime.RunOptions) error {
				return h.fakeBot(ctx, "slack", jobHooks{Poke: opts.Server.Poke, CronRun: opts.Server.CronRun, Triggers: opts.JobTriggers})
			},
			mixin: func(ctx context.Context, _ mixinruntime.Dependencies, _ mixinruntime.RunOptions) error {
				return h.fakeBot(ctx, "mixin", jobHooks{})
			},
			discord: func(ctx context.Context, _ discordruntime.Dependencies, opts discordruntime.RunOptions) error {
				return h.fakeBot(ctx, "discord", jobHooks{Poke: opts.Poke, CronRun: opts.CronRun})
			},
			wechat: func(ctx context.Context, _ accountdm.Dependencies, opts wechatruntime.RunOptions) error {
				return h.fakeBot(ctx, "wechat", jobHooks{Poke: opts.Poke, CronRun: opts.CronRun})
			},
			whatsapp: func(ctx context.Context, _ accountdm.Dependencies, opts whatsappruntime.RunOptions) error {
				return h.fakeBot(ctx, "whatsapp", jobHooks{Poke: opts.Poke, CronRun: opts.CronRun})
			},
		},
	})
	if err := h.rt.Err(); err != nil {
		t.Fatalf("runtime config: %v", err)
	}
	h.stateDir = h.rt.snapshot().Paths.StateDir
	h.cronPath = h.rt.snapshot().Paths.CronPath
	return h
}

func (h *jobsHarness) chat(_ context.Context, req llm.Request) (llm.Result, error) {
	var b strings.Builder
	for _, msg := range req.Messages {
		b.WriteString(msg.Content)
		b.WriteString("\n")
	}
	h.mu.Lock()
	h.prompts = append(h.prompts, b.String())
	h.mu.Unlock()
	return llm.Result{Text: `{"type":"final","output":"job done"}`}, nil
}

func (h *jobsHarness) fakeBot(ctx context.Context, name string, hooks jobHooks) error {
	h.started[name] <- hooks
	<-ctx.Done()
	return nil
}

func (h *jobsHarness) seedJobs(tasks ...cronstore.Task) {
	h.t.Helper()
	if err := cronstore.NewStore(h.cronPath).Write(cronstore.File{Tasks: tasks}); err != nil {
		h.t.Fatalf("seed jobs: %v", err)
	}
}

// waitPrompt waits for a model request that carries marker, the content of a job's run.
func (h *jobsHarness) waitPrompt(marker string) {
	h.t.Helper()
	deadline := time.Now().Add(jobsTestWait)
	for time.Now().Before(deadline) {
		if h.promptCount(marker) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("no model request carried %q", marker)
}

func (h *jobsHarness) promptCount(marker string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, prompt := range h.prompts {
		if strings.Contains(prompt, marker) {
			n++
		}
	}
	return n
}

// waitRun waits for the job's latest run to end with status.
func (h *jobsHarness) waitRun(jobID, status string) cronstore.RunRecord {
	h.t.Helper()
	store := cronstore.NewStore(h.cronPath)
	deadline := time.Now().Add(jobsTestWait)
	for time.Now().Before(deadline) {
		if run, ok, err := store.LatestRun(context.Background(), jobID); err == nil && ok && run.Status == status {
			return run
		}
		time.Sleep(10 * time.Millisecond)
	}
	run, ok, err := store.LatestRun(context.Background(), jobID)
	h.t.Fatalf("job %s run = %+v, %v, %v; want %s", jobID, run, ok, err, status)
	return cronstore.RunRecord{}
}

type runningBot struct {
	cancel context.CancelFunc
	// done closes when Run returns; err is what it returned.
	done  chan struct{}
	err   error
	hooks jobHooks
}

func (b *runningBot) stop(t *testing.T) error {
	t.Helper()
	b.cancel()
	select {
	case <-b.done:
		return b.err
	case <-time.After(jobsTestWait):
		t.Fatal("bot Run did not return after its context ended")
		return nil
	}
}

func (h *jobsHarness) startBot(name string) *runningBot {
	h.t.Helper()
	var runner BotRunner
	var err error
	switch name {
	case "telegram":
		runner, err = h.rt.NewTelegramBot(TelegramOptions{BotToken: "test"})
	case "slack":
		runner, err = h.rt.NewSlackBot(SlackOptions{BotToken: "xoxb-test", AppToken: "xapp-test"})
	case "mixin":
		runner, err = h.rt.NewMixinBot(validMixinOptions())
	case "discord":
		runner, err = h.rt.NewDiscordBot(DiscordOptions{BotToken: "test"})
	case "wechat":
		runner, err = h.rt.NewWeChatBot(WeChatOptions{BotToken: "test"})
	case "whatsapp":
		runner, err = h.rt.NewWhatsAppBot(WhatsAppOptions{APIToken: "test"})
	}
	if err != nil {
		h.t.Fatalf("new %s bot: %v", name, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	bot := &runningBot{cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(bot.done)
		bot.err = runner.Run(ctx)
	}()
	select {
	case bot.hooks = <-h.started[name]:
	case <-bot.done:
		cancel()
		h.t.Fatalf("%s bot ended before it started: %v", name, bot.err)
	case <-time.After(jobsTestWait):
		cancel()
		h.t.Fatalf("%s bot did not start", name)
	}
	h.t.Cleanup(func() {
		cancel()
		<-bot.done
	})
	return bot
}

func (h *jobsHarness) liveLoop() *jobLoop {
	h.rt.jobs.mu.Lock()
	defer h.rt.jobs.mu.Unlock()
	if h.rt.jobs.loop == nil || h.rt.jobs.loop.ctx.Err() != nil {
		return nil
	}
	return h.rt.jobs.loop
}

func (h *jobsHarness) owners() int {
	h.rt.jobs.mu.Lock()
	defer h.rt.jobs.mu.Unlock()
	return h.rt.jobs.owners
}

func pastOnce(id, content string) cronstore.Task {
	at := time.Now().UTC().Add(-time.Minute).Format("2006-01-02 15:04")
	return cronstore.Task{ID: id, Content: content, At: at, TZ: "UTC",
		Triggers: []cronstore.Trigger{{ID: "trg-once", Kind: cronstore.TriggerSchedule, At: at, TZ: "UTC"}}}
}

// A job that comes due runs on schedule in an embedded runtime with no mistermorph process around:
// RunJobs runs it through the model, records the run in the job history and in the integration
// task store under the job's topic, and returns nil when its context ends.
func TestRunJobsRunsADueScheduledJob(t *testing.T) {
	h := newJobsHarness(t, jobsTestConfig(t))
	h.seedJobs(pastOnce("report", "scheduled-job-marker: write the report"))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.rt.RunJobs(ctx) }()

	h.waitPrompt("scheduled-job-marker")
	run := h.waitRun("report", cronstore.RunStatusDone)
	if run.Cause.Kind != cronstore.CauseSchedule {
		t.Fatalf("run cause = %+v, want schedule", run.Cause)
	}
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{
		RootDir: h.rt.snapshot().Paths.TaskTargetDir(defaultIntegrationTaskTarget), Target: defaultIntegrationTaskTarget,
		Persist: true, JournalDir: h.rt.snapshot().Paths.JournalDir, SkipRecovery: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(jobsTestWait)
	for {
		items := store.List(daemonruntime.TaskListOptions{TopicID: daemonruntime.CronTopicID("report"), Limit: 10})
		if len(items) == 1 && items[0].Status == daemonruntime.TaskDone {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("integration task records of the job = %+v", items)
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RunJobs() = %v", err)
		}
	case <-time.After(jobsTestWait):
		t.Fatal("RunJobs did not return after its context ended")
	}
	if h.liveLoop() != nil {
		t.Fatal("the job loop still runs after its last owner returned")
	}
}

// A message that matches a job's message trigger, handed to the dispatcher a channel bot started
// by integration gets, starts that job; the bot's job poke trigger starts a job too.
func TestChannelBotStartsJobsFromMessagesAndPokes(t *testing.T) {
	for _, channel := range []string{"telegram", "slack"} {
		t.Run(channel, func(t *testing.T) {
			h := newJobsHarness(t, jobsTestConfig(t))
			chatID := map[string]string{"telegram": "tg:-100123", "slack": "slack:T1:C1"}[channel]
			h.seedJobs(
				cronstore.Task{ID: "watcher", Content: "message-job-marker: triage", Triggers: []cronstore.Trigger{
					{ID: "trg-msg", Kind: cronstore.TriggerMessage, Channel: channel, ChatID: chatID}}},
				cronstore.Task{ID: "poked", Content: "poke-job-marker: refresh", Triggers: []cronstore.Trigger{
					{ID: "trg-poke", Kind: cronstore.TriggerPoke}}},
			)
			bot := h.startBot(channel)
			if bot.hooks.Triggers == nil || bot.hooks.CronRun == nil || bot.hooks.Poke == nil {
				t.Fatalf("bot hooks = %+v, want poke, job run and message triggers", bot.hooks)
			}

			results := bot.hooks.Triggers.Handle(context.Background(), jobtriggers.Message{
				Channel: channel, ChatIDs: []string{chatID}, MessageID: "m1", SenderID: "u1", Text: "server is down", SentAt: time.Now(),
			})
			if len(results) != 1 || results[0].Outcome != jobtriggers.Started || results[0].JobID != "watcher" {
				t.Fatalf("message trigger results = %+v", results)
			}
			h.waitPrompt("message-job-marker")
			if run := h.waitRun("watcher", cronstore.RunStatusDone); run.Cause.Kind != cronstore.CauseMessage {
				t.Fatalf("watcher run cause = %+v", run.Cause)
			}

			task, _, err := cronstore.NewStore(h.cronPath).FindByID("poked")
			if err != nil {
				t.Fatal(err)
			}
			runID, err := bot.hooks.CronRun(context.Background(), cronstore.RunRequest{Task: task, Cause: cronstore.RunCause{Kind: cronstore.CausePoke, TriggerID: "trg-poke"}})
			if err != nil || runID == "" {
				t.Fatalf("CronRun() = %q, %v", runID, err)
			}
			h.waitPrompt("poke-job-marker")
			if run := h.waitRun("poked", cronstore.RunStatusDone); run.RunID != runID || run.Cause.Kind != cronstore.CausePoke {
				t.Fatalf("poked run = %+v, want %s by poke", run, runID)
			}
			if err := bot.stop(t); err != nil {
				t.Fatalf("bot Run() = %v", err)
			}
		})
	}
}

// Every channel bot gets the job triggers its channel runtime takes, and all of them share one
// loop: it outlives each bot but the last, which returns only once the loop has stopped. A bot
// started afterwards starts a new loop.
func TestChannelBotsShareOneJobLoop(t *testing.T) {
	h := newJobsHarness(t, jobsTestConfig(t))
	names := []string{"telegram", "slack", "mixin", "discord", "wechat", "whatsapp"}
	bots := map[string]*runningBot{}
	for _, name := range names {
		bots[name] = h.startBot(name)
	}
	loop := h.liveLoop()
	if loop == nil || h.owners() != len(names) {
		t.Fatalf("loop = %v, owners = %d; want one loop owned by %d bots", loop, h.owners(), len(names))
	}
	for _, name := range names {
		hooks := bots[name].hooks
		wantTriggers := name == "telegram" || name == "slack"
		if name == "mixin" {
			if hooks.CronRun != nil || hooks.Poke != nil {
				t.Fatalf("mixin got hooks %+v", hooks)
			}
			continue
		}
		if hooks.CronRun == nil || hooks.Poke == nil || (hooks.Triggers != nil) != wantTriggers {
			t.Fatalf("%s hooks = %+v", name, hooks)
		}
		if wantTriggers && hooks.Triggers != loop.dispatcher {
			t.Fatalf("%s got a dispatcher of its own", name)
		}
	}
	h.mu.Lock()
	conns := h.mcpConns
	h.mu.Unlock()
	if conns != len(names)+1 {
		t.Fatalf("MCP connections = %d, want one per bot and one for the loop", conns)
	}

	for _, name := range names[:len(names)-1] {
		if err := bots[name].stop(t); err != nil {
			t.Fatalf("%s Run() = %v", name, err)
		}
		if h.liveLoop() != loop {
			t.Fatalf("the job loop stopped when %s, not the last bot, stopped", name)
		}
	}
	if err := bots[names[len(names)-1]].stop(t); err != nil {
		t.Fatalf("last bot Run() = %v", err)
	}
	select {
	case <-loop.done:
	default:
		t.Fatal("the last bot returned before the job loop stopped")
	}
	if loop.err != nil {
		t.Fatalf("loop error = %v", loop.err)
	}
	h.mu.Lock()
	closed := h.mcpClose
	h.mu.Unlock()
	if closed != len(names)+1 {
		t.Fatalf("MCP closes = %d, want %d", closed, len(names)+1)
	}

	// A trigger kept from the stopped loop fails at once rather than waiting for it.
	stale := bots["telegram"].hooks.CronRun
	task := cronstore.Task{ID: "late", Content: "late", Triggers: []cronstore.Trigger{}}
	if _, err := stale(context.Background(), cronstore.RunRequest{Task: task}); !errors.Is(err, errJobsStopped) {
		t.Fatalf("stale CronRun() = %v, want %v", err, errJobsStopped)
	}

	// Restart: a new bot gets a new loop that runs jobs.
	h.seedJobs(cronstore.Task{ID: "again", Content: "restart-job-marker", Triggers: []cronstore.Trigger{}})
	bot := h.startBot("telegram")
	if next := h.liveLoop(); next == nil || next == loop {
		t.Fatal("the restarted bot did not start a new job loop")
	}
	again, _, err := cronstore.NewStore(h.cronPath).FindByID("again")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bot.hooks.CronRun(context.Background(), cronstore.RunRequest{Task: again}); err != nil {
		t.Fatalf("CronRun() after restart = %v", err)
	}
	h.waitRun("again", cronstore.RunStatusDone)
	if err := bot.stop(t); err != nil {
		t.Fatalf("restarted bot Run() = %v", err)
	}
}

// With jobs off (job_manage switched off, job_manage left out of BuiltinToolNames, or cron.enabled
// false), neither bots nor RunJobs start a job loop or a trigger dispatcher, and due jobs stay put.
func TestJobsOffStartsNoLoop(t *testing.T) {
	cases := map[string]func(*Config){
		"job_manage off":         func(cfg *Config) { cfg.Set("tools.job_manage.enabled", false) },
		"legacy todo_update off": func(cfg *Config) { cfg.Set("tools.todo_update.enabled", false) },
		"job_manage not selected": func(cfg *Config) {
			cfg.BuiltinToolNames = []string{"read_file"}
		},
		"cron off": func(cfg *Config) { cfg.Set("cron.enabled", false) },
	}
	for name, configure := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := jobsTestConfig(t)
			configure(&cfg)
			h := newJobsHarness(t, cfg)
			h.seedJobs(pastOnce("report", "disabled-job-marker"))

			if err := h.rt.RunJobs(context.Background()); err != nil {
				t.Fatalf("RunJobs() = %v, want nil at once", err)
			}
			bot := h.startBot("telegram")
			if bot.hooks.Poke != nil || bot.hooks.CronRun != nil || bot.hooks.Triggers != nil {
				t.Fatalf("bot hooks = %+v, want none", bot.hooks)
			}
			if h.liveLoop() != nil || h.owners() != 0 {
				t.Fatal("a job loop started with jobs off")
			}
			if err := bot.stop(t); err != nil {
				t.Fatalf("bot Run() = %v", err)
			}
			h.mu.Lock()
			conns := h.mcpConns
			h.mu.Unlock()
			if conns != 1 {
				t.Fatalf("MCP connections = %d, want only the bot's", conns)
			}
			if n := h.promptCount("disabled-job-marker"); n != 0 {
				t.Fatalf("the due job ran %d times with jobs off", n)
			}
		})
	}
}

// A job loop that cannot start fails its owners: a bot stops with the error, as a CLI command
// stops its channel when the awareness loop beside it fails, and RunJobs returns it.
func TestJobLoopFailureStopsItsOwners(t *testing.T) {
	t.Run("loop fails after starting", func(t *testing.T) {
		cfg := jobsTestConfig(t)
		// The awareness loop resolves a model of its own route; the bot needs none here.
		cfg.Set("llm.model", "")
		h := newJobsHarness(t, cfg)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		runner, err := h.rt.NewTelegramBot(TelegramOptions{BotToken: "test"})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- runner.Run(ctx) }()
		select {
		case err := <-done:
			if err == nil || !strings.Contains(err.Error(), "jobs runner") || !strings.Contains(err.Error(), "missing model") {
				t.Fatalf("bot Run() = %v, want the job loop's error", err)
			}
		case <-time.After(jobsTestWait):
			t.Fatal("the bot kept running after the job loop failed")
		}
		if err := h.rt.RunJobs(context.Background()); err == nil || !strings.Contains(err.Error(), "missing model") {
			t.Fatalf("RunJobs() = %v, want the job loop's error", err)
		}
		if h.liveLoop() != nil {
			t.Fatal("a failed job loop is still live")
		}
	})
	t.Run("loop cannot be prepared", func(t *testing.T) {
		h := newJobsHarness(t, jobsTestConfig(t))
		h.failMCP = errors.New("mcp down")
		runner, err := h.rt.NewSlackBot(SlackOptions{BotToken: "xoxb-test", AppToken: "xapp-test"})
		if err != nil {
			t.Fatal(err)
		}
		if err := runner.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "mcp down") {
			t.Fatalf("bot Run() = %v, want the MCP error", err)
		}
		select {
		case hooks := <-h.started["slack"]:
			t.Fatalf("the bot started without its job loop: %+v", hooks)
		default:
		}
		if h.liveLoop() != nil || h.owners() != 0 {
			t.Fatal("a job loop is left after it failed to start")
		}
	})
}

// The runtime API owns the job loop while it serves: POST /poke/{job_id} starts the job.
func TestServeRuntimeAPIPokesJobs(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	cfg := jobsTestConfig(t)
	cfg.Set("server.listen", addr)
	cfg.Set("server.auth_token", runtimeAPITestToken)
	h := newJobsHarness(t, cfg)
	h.seedJobs(cronstore.Task{ID: "poked", Content: "api-poke-marker", Triggers: []cronstore.Trigger{
		{ID: "trg-poke", Kind: cronstore.TriggerPoke}}})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.rt.ServeRuntimeAPI(ctx, RuntimeAPIOptions{}) }()
	var status int
	deadline := time.Now().Add(jobsTestWait)
	for {
		req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://%s/poke/poked", addr), strings.NewReader("disk full"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+runtimeAPITestToken)
		req.Header.Set("Content-Type", "text/plain")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			status = resp.StatusCode
			_ = resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("runtime API never answered: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != http.StatusAccepted {
		t.Fatalf("POST /poke/poked status = %d", status)
	}
	h.waitPrompt("api-poke-marker")
	h.waitRun("poked", cronstore.RunStatusDone)

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("ServeRuntimeAPI() = %v", err)
		}
	case <-time.After(jobsTestWait):
		t.Fatal("ServeRuntimeAPI did not return")
	}
	if h.liveLoop() != nil {
		t.Fatal("the job loop outlived the runtime API")
	}
}

// The job loop runs with the runtime's own settings, the heartbeat as heartbeat.* says.
func TestJobRunOptionsFollowTheConfig(t *testing.T) {
	cfg := jobsTestConfig(t)
	cfg.Set("heartbeat.enabled", true)
	cfg.Set("heartbeat.interval", "45m")
	cfg.Set("cron.max_concurrency", 3)
	cfg.Set("timeout", "7m")
	cfg.Set("tools.spawn.enabled", true)
	cfg.BuiltinToolNames = []string{"job_manage"}
	h := newJobsHarness(t, cfg)
	snap := h.rt.snapshot()
	opts := h.rt.jobRunOptions(snap)
	if opts.DisableHeartbeat || opts.Interval != 45*time.Minute || !opts.CronEnabled || opts.CronMaxConcurrency != 3 ||
		opts.TaskTimeout != 7*time.Minute || opts.Source != "integration" || opts.CronPath != filepath.Join(h.stateDir, "cron.yaml") ||
		opts.ChecklistPath != snap.Paths.HeartbeatPath {
		t.Fatalf("run options = %+v", opts)
	}
	if opts.EngineToolsConfig.SpawnEnabled {
		t.Fatal("spawn is on although BuiltinToolNames leaves it out")
	}
	if scope := opts.TopicContextScope("_cron_x"); scope.Runtime != "integration" || scope.TopicID != "_cron_x" {
		t.Fatalf("topic scope = %+v", scope)
	}

	off := jobsTestConfig(t)
	off.Set("heartbeat.interval", "30m")
	offRuntime := newJobsHarness(t, off).rt
	if opts := offRuntime.jobRunOptions(offRuntime.snapshot()); !opts.DisableHeartbeat {
		t.Fatal("the heartbeat runs although heartbeat.enabled is false")
	}
}

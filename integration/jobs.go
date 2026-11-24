package integration

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/quailyquaily/mistermorph/agent"
	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	awarenessruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/chatinfo"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/jobtriggers"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
)

// errJobsStopped is what a job trigger returns once the job loop it belongs to has stopped.
var errJobsStopped = errors.New("jobs runner stopped")

// RunJobs runs the jobs of this runtime until ctx ends: scheduled jobs and the heartbeat, and the
// runs a channel bot or the runtime API starts by hand, by poke or by a message trigger. It
// returns nil when ctx ends, and at once when jobs are off (job_manage switched off or not in
// BuiltinToolNames, or cron.enabled false).
//
// The runtime keeps one job loop, however many owners it has: each running channel bot,
// ServeRuntimeAPI and each RunJobs call is one. The loop starts with the first owner and stops,
// waiting for the runs it started, when the last one returns. A program that runs no channel bot
// and no runtime API calls RunJobs to have its jobs run. RunJobs returns an error if the loop
// fails; the next owner starts a new one.
func (rt *Runtime) RunJobs(ctx context.Context) error {
	if err := rt.Err(); err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	lease, err := rt.acquireJobs(rt.snapshot())
	if err != nil {
		return err
	}
	defer lease.release()
	if lease.loop == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return nil
	case <-lease.loop.done:
		return lease.failure()
	}
}

// jobsEnabled reports whether this runtime runs jobs: job_manage is on and selected, and cron
// scheduling is on, as the CLI commands run the job loop beside a channel only with cron.enabled.
func (rt *Runtime) jobsEnabled(snap runtimeSnapshot) bool {
	return rt != nil && snap.InitErr == nil &&
		snap.Registry.ToolsJobManageEnabled && rt.isBuiltinToolSelected(toolsutil.BuiltinJobManage) &&
		snap.Cron.Enabled
}

// jobRunner owns the runtime's one job loop and counts the owners keeping it alive.
type jobRunner struct {
	mu     sync.Mutex
	owners int
	loop   *jobLoop
}

// jobLoop is one run of the awareness loop with jobs on.
type jobLoop struct {
	// ctx ends when the last owner leaves or the loop stops by itself.
	ctx    context.Context
	cancel context.CancelFunc
	// done closes once the loop and everything it started have stopped; err is set before.
	done     chan struct{}
	err      error
	triggers awarenessruntime.Triggers
	// dispatcher starts the jobs whose message triggers match a channel bot's inbound messages.
	dispatcher *jobtriggers.Dispatcher
}

// jobHooks are what a channel bot or the runtime API gets from the job loop; all nil when jobs
// are off.
type jobHooks struct {
	Poke     daemonruntime.PokeFunc
	CronRun  daemonruntime.CronRunFunc
	Triggers *jobtriggers.Dispatcher
}

// jobLease is one owner's hold on the job loop; loop is nil when jobs are off.
type jobLease struct {
	loop    *jobLoop
	release func()
}

func (l *jobLease) hooks() jobHooks {
	if l == nil || l.loop == nil {
		return jobHooks{}
	}
	return jobHooks{Poke: l.loop.poke, CronRun: l.loop.cronRun, Triggers: l.loop.dispatcher}
}

// failure is the error the loop stopped with when it stopped by itself, or nil.
func (l *jobLease) failure() error {
	if l == nil || l.loop == nil {
		return nil
	}
	select {
	case <-l.loop.done:
		return l.loop.err
	default:
		return nil
	}
}

// cancelOnFailure calls cancel if the loop fails while the owner runs, as a CLI command stops its
// channel when the awareness loop beside it fails. The returned function stops watching.
func (l *jobLease) cancelOnFailure(cancel context.CancelFunc) func() {
	if l == nil || l.loop == nil {
		return func() {}
	}
	stop := make(chan struct{})
	go func() {
		select {
		case <-l.loop.done:
			if l.loop.err != nil {
				cancel()
			}
		case <-stop:
		}
	}()
	return func() { close(stop) }
}

// acquireJobs makes the caller an owner of the job loop, starting it if none runs. Release the
// lease when the owner stops: the last release stops the loop and waits for it.
func (rt *Runtime) acquireJobs(snap runtimeSnapshot) (*jobLease, error) {
	if !rt.jobsEnabled(snap) {
		return &jobLease{release: func() {}}, nil
	}
	j := &rt.jobs
	j.mu.Lock()
	defer j.mu.Unlock()
	loop := j.loop
	if loop != nil && loop.ctx.Err() != nil {
		// The last owner left or the loop failed, and it may still be winding down: two loops of
		// one runtime never overlap.
		<-loop.done
		loop = nil
	}
	if loop == nil {
		var err error
		loop, err = rt.startJobLoop(snap)
		if err != nil {
			j.loop = nil
			return nil, err
		}
		j.loop = loop
		j.owners = 0
	}
	j.owners++
	var once sync.Once
	return &jobLease{loop: loop, release: func() { once.Do(func() { rt.releaseJobs(loop) }) }}, nil
}

func (rt *Runtime) releaseJobs(loop *jobLoop) {
	j := &rt.jobs
	j.mu.Lock()
	last := false
	if j.loop == loop {
		j.owners--
		if j.owners <= 0 {
			j.owners = 0
			last = true
			loop.cancel()
		}
	}
	j.mu.Unlock()
	if last {
		<-loop.done
	}
}

func (rt *Runtime) startJobLoop(snap runtimeSnapshot) (*jobLoop, error) {
	logger := snap.Logger
	if logger == nil {
		logger = slog.Default()
	}
	// The loop outlives the owner that started it, so it takes none of that owner's context.
	ctx, cancel := context.WithCancel(context.Background())
	deps, closeDeps, err := rt.prepareChannelDependencies(ctx, snap)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("jobs runner: %w", err)
	}
	// Runs are recorded beside the program's own tasks and the runtime API's, under the
	// integration target: a job's output is read from there by the jobs that use it.
	journal, err := taskdomain.NewJournal(snap.Paths.JournalDir, snap.Registry.TasksRotateMaxBytes)
	if err != nil {
		cancel()
		return nil, errors.Join(fmt.Errorf("jobs runner: open task journal: %w", err), closeDeps())
	}
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{
		RootDir:        snap.Paths.TaskTargetDir(defaultIntegrationTaskTarget),
		Target:         defaultIntegrationTaskTarget,
		Persist:        true,
		Journal:        journal,
		RotateMaxBytes: snap.Registry.TasksRotateMaxBytes,
		// The program and the runtime API may be running tasks of their own.
		SkipRecovery: true,
	})
	if err != nil {
		cancel()
		return nil, errors.Join(fmt.Errorf("jobs runner: open task store: %w", err), journal.Close(), closeDeps())
	}
	opts := rt.jobRunOptions(snap)
	opts.TaskStore = store
	loop := &jobLoop{
		ctx:      ctx,
		cancel:   cancel,
		done:     make(chan struct{}),
		triggers: awarenessruntime.AttachTriggers(&opts),
	}
	loop.dispatcher = jobtriggers.New(opts.CronPath, loop.cronRun, logger)
	go func() {
		defer close(loop.done)
		runErr := awarenessruntime.Run(ctx, deps, opts)
		stopped := ctx.Err() != nil
		cancel()
		closeErr := errors.Join(closeDeps(), journal.Close())
		if !stopped {
			if runErr == nil {
				runErr = errors.New("stopped unexpectedly")
			}
			loop.err = fmt.Errorf("jobs runner: %w", errors.Join(runErr, closeErr))
			logger.Warn("integration_jobs_error", "error", loop.err.Error())
			return
		}
		if err := errors.Join(runErr, closeErr); err != nil {
			logger.Warn("integration_jobs_close_error", "error", err.Error())
		}
	}()
	return loop, nil
}

// jobRunOptions are the awareness loop options of this runtime, as the CLI commands build them
// beside a channel: the heartbeat follows heartbeat.*, jobs cron.*.
func (rt *Runtime) jobRunOptions(snap runtimeSnapshot) awarenessruntime.RunOptions {
	engineTools := agent.EngineToolsConfig{
		SpawnEnabled:  snap.Registry.ToolsSpawnEnabled,
		CoderEnabled:  snap.Registry.ToolsCoderEnabled,
		CoderEnv:      snap.Registry.ToolsCoderEnv,
		WorkerNameSet: snap.Registry.ToolsAgentNameSet,
	}
	rt.gateEngineTools(&engineTools)
	return awarenessruntime.RunOptions{
		Interval:          snap.Heartbeat.Interval,
		TaskTimeout:       snap.TaskTimeout,
		RequestTimeout:    snap.LLMRequestTimeout,
		AgentLimits:       snap.AgentLimits,
		EngineToolsConfig: engineTools,
		Source:            defaultIntegrationTaskTarget,
		ChecklistPath:     snap.Paths.HeartbeatPath,
		DisableHeartbeat:  !snap.Heartbeat.Enabled || snap.Heartbeat.Interval <= 0,
		InspectPrompt:     rt.inspect.Prompt,
		InspectRequest:    rt.inspect.Request,
		// Heartbeat alerts stay in the logs, as in the CLI channel commands.
		Notifier:           nil,
		CronEnabled:        true,
		CronMaxConcurrency: snap.Cron.MaxConcurrency,
		CronPath:           snap.Paths.CronPath,
		ChatInfoRefresher:  chatinfo.NewFetcher(snap.ChatInfo),
		TopicContextScope: func(topicID string) topiccontext.Scope {
			return topiccontext.Scope{Runtime: defaultIntegrationTaskTarget, ConversationKey: "integration:" + topicID, TopicID: topicID}
		},
	}
}

// bound returns a context that also ends when the loop stops, so a trigger never waits on a loop
// that no longer reads its requests.
func (l *jobLoop) bound(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(l.ctx, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

func (l *jobLoop) cronRun(ctx context.Context, run cronstore.RunRequest) (string, error) {
	if l.ctx.Err() != nil {
		return "", errJobsStopped
	}
	bounded, cancel := l.bound(ctx)
	defer cancel()
	runID, err := l.triggers.CronRun(bounded, run)
	if err != nil && l.ctx.Err() != nil && (ctx == nil || ctx.Err() == nil) {
		return "", errJobsStopped
	}
	return runID, err
}

func (l *jobLoop) poke(ctx context.Context, input awarenessdomain.PokeInput) error {
	if l.ctx.Err() != nil {
		return errJobsStopped
	}
	bounded, cancel := l.bound(ctx)
	defer cancel()
	err := l.triggers.Poke(bounded, input)
	if err != nil && l.ctx.Err() != nil && (ctx == nil || ctx.Err() == nil) {
		return errJobsStopped
	}
	return err
}

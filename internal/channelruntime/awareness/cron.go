package awareness

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

const cronTickInterval = time.Minute
const DefaultHeartbeatInterval = configdefaults.DefaultHeartbeatInterval

type CronLoopOptions struct {
	Logger      *slog.Logger
	Source      string
	Path        string
	SystemTasks []cronstore.Task
	Run         func(context.Context, cronstore.DueTask) error
	Now         func() time.Time
	Requests    <-chan CronRequest
	// MaxConcurrency is how many TODO items may run at once; values below 1 mean 1. System tasks
	// (the heartbeat) run beside them in a lane of their own, so long items do not hold them up.
	MaxConcurrency int
}

// CronRequest asks a cron loop to run a task now. A zero Cause is a person's (manual).
type CronRequest struct {
	Task  cronstore.Task
	Cause cronstore.RunCause
	// Input is the body of the request that asked (a per-job poke), for the run to read as data.
	Input  awarenessdomain.PokeInput
	Result chan error
	// RunID, when set, is sent the queued run's ID before Result gets nil. It must not block.
	RunID chan string
}

// TriggerCron asks the loop to run task now, as a person's manual run.
func TriggerCron(ctx context.Context, requests chan<- CronRequest, task cronstore.Task) error {
	_, err := StartCronRun(ctx, requests, cronstore.RunRequest{Task: task})
	return err
}

// StartCronRun asks the loop to run the request's task now and returns the queued run's ID.
func StartCronRun(ctx context.Context, requests chan<- CronRequest, run cronstore.RunRequest) (string, error) {
	if requests == nil {
		return "", fmt.Errorf("cron trigger is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := cronstore.ValidateTask(run.Task); err != nil {
		return "", err
	}
	req := CronRequest{
		Task:   run.Task,
		Cause:  run.Cause,
		Input:  run.Input,
		Result: make(chan error, 1),
		RunID:  make(chan string, 1),
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case requests <- req:
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case err := <-req.Result:
		if err != nil {
			return "", err
		}
		select {
		case runID := <-req.RunID:
			return runID, nil
		default:
			return "", nil
		}
	}
}

const (
	cronQueueSize       = 1024
	cronSystemQueueSize = 16
)

func RunCronLoop(ctx context.Context, opts CronLoopOptions) {
	if ctx == nil {
		ctx = context.Background()
	}
	if opts.Run == nil || strings.TrimSpace(opts.Path) == "" {
		<-ctx.Done()
		return
	}
	workers := opts.MaxConcurrency
	if workers < 1 {
		workers = 1
	}
	r := newCronLoopRunner(opts)
	unregister := cronstore.RegisterRunBoard(opts.Path, r.board)
	defer unregister()
	// Runs a runtime left queued or running when it stopped without ending them.
	if n, err := r.store.FailStaleRuns(ctx, r.now().Add(-cronstore.StaleRunAfter)); err != nil {
		r.warn("cron_run_record_error", "error", err.Error())
	} else if n > 0 {
		r.info("cron_stale_runs_failed", "count", n)
	}

	var workerGroup sync.WaitGroup
	workerGroup.Add(workers + 1)
	for i := 0; i < workers; i++ {
		go func() {
			defer workerGroup.Done()
			r.worker(ctx, r.queue)
		}()
	}
	go func() {
		defer workerGroup.Done()
		r.worker(ctx, r.systemQueue)
	}()
	workerDone := make(chan struct{})
	go func() {
		workerGroup.Wait()
		close(workerDone)
	}()
	schedulerQuiesced := make(chan struct{})
	schedulerDone := make(chan struct{})
	go func() {
		defer close(schedulerDone)
		r.runScheduler(ctx, workerDone, schedulerQuiesced)
	}()
	requests := opts.Requests
	for {
		select {
		case <-ctx.Done():
			// Nothing enqueues once the scheduler is quiet and this loop stops taking requests,
			// so the queues can close. Workers wait for running items and log the queued ones.
			<-schedulerQuiesced
			r.closeQueues()
			<-workerDone
			<-schedulerDone
			return
		case req, ok := <-requests:
			if !ok {
				requests = nil
				continue
			}
			cause := req.Cause
			if strings.TrimSpace(cause.Kind) == "" {
				cause.Kind = cronstore.CauseManual
			}
			runID, err := r.enqueue(ctx, cronstore.DueTask{
				Task:           req.Task,
				ScheduledAtUTC: r.now().UTC(),
				Cause:          cause,
				Input:          req.Input,
			})
			if err == nil && req.RunID != nil {
				select {
				case req.RunID <- runID:
				default:
				}
			}
			req.Result <- err
		}
	}
}

func newCronLoopRunner(opts CronLoopOptions) *cronLoopRunner {
	r := &cronLoopRunner{
		opts:        opts,
		store:       cronstore.NewStore(opts.Path),
		queue:       make(chan cronstore.DueTask, cronQueueSize),
		systemQueue: make(chan cronstore.DueTask, cronSystemQueueSize),
		systemIDs:   map[string]bool{},
		inFlight:    map[string]bool{},
		board:       &cronstore.RunBoard{},
	}
	for _, task := range opts.SystemTasks {
		if id := strings.TrimSpace(task.ID); id != "" {
			r.systemIDs[id] = true
		}
	}
	return r
}

type cronLoopRunner struct {
	opts        CronLoopOptions
	store       *cronstore.Store
	queue       chan cronstore.DueTask
	systemQueue chan cronstore.DueTask
	systemIDs   map[string]bool
	board       *cronstore.RunBoard

	mu       sync.Mutex
	inFlight map[string]bool

	// queueMu guards the queues against a send after they closed: a worker that ends a run at
	// shutdown may still try to queue the jobs that use it.
	queueMu sync.RWMutex
	closed  bool
	// chainMu makes the step from a finished run to the jobs that use it one at a time, so two
	// inputs that end together start a job that waits for both only once.
	chainMu sync.Mutex
}

func (r *cronLoopRunner) closeQueues() {
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	r.closed = true
	close(r.queue)
	close(r.systemQueue)
}

func (r *cronLoopRunner) runScheduler(ctx context.Context, workerDone <-chan struct{}, schedulerQuiesced chan<- struct{}) {
	quiesced := false
	markQuiesced := func() {
		if quiesced {
			return
		}
		close(schedulerQuiesced)
		quiesced = true
	}
	defer markQuiesced()

	lockPath, err := cronstore.SchedulerLockPath(r.opts.Path)
	if err != nil {
		r.warn("cron_scheduler_lock_error", "error", err.Error())
		return
	}
	err = fsstore.WithLock(ctx, lockPath, func() error {
		r.tick(ctx)
		ticker := time.NewTicker(cronTickInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				markQuiesced()
				<-workerDone
				return nil
			case <-ticker.C:
				r.tick(ctx)
			}
		}
	})
	if err != nil && ctx.Err() == nil {
		r.warn("cron_scheduler_lock_error", "error", err.Error())
	}
}

func (r *cronLoopRunner) tick(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	now := r.now().UTC()
	due, taskErrs, err := r.store.DueLenient(now)
	if err != nil {
		r.warn("cron_tick_error", "error", err.Error())
		return
	}
	systemDue, systemTaskErrs := dueSystemTasks(r.opts.SystemTasks, now)
	due = append(systemDue, due...)
	taskErrs = append(taskErrs, systemTaskErrs...)
	for _, taskErr := range taskErrs {
		if taskErr != nil {
			r.warn("cron_task_invalid", "error", taskErr.Error())
		}
	}
	for _, item := range due {
		if _, err := r.enqueue(ctx, item); err != nil {
			id := strings.TrimSpace(item.Task.ID)
			if errors.Is(err, daemonruntime.ErrCronBusy) {
				r.debug("cron_skip", "task_id", id, "reason", "already_queued_or_running")
				continue
			}
			if strings.Contains(err.Error(), "queue is full") {
				r.warn("cron_skip", "task_id", id, "reason", "queue_full")
				continue
			}
			r.warn("cron_skip", "task_id", id, "reason", err.Error())
		}
	}
}

// enqueue queues one run of the item's task and returns its run ID. A stored job's run is added
// to the run history, queued, before a worker can take it.
func (r *cronLoopRunner) enqueue(ctx context.Context, item cronstore.DueTask) (string, error) {
	if ctx != nil {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}
	}
	if err := cronstore.ValidateTask(item.Task); err != nil {
		return "", err
	}
	id := strings.TrimSpace(item.Task.ID)
	if id == "" {
		return "", fmt.Errorf("cron task id is required")
	}
	r.queueMu.RLock()
	defer r.queueMu.RUnlock()
	if r.closed {
		return "", context.Canceled
	}
	if !r.markInFlight(id) {
		return "", daemonruntime.ErrCronBusy
	}
	queue := r.queue
	if r.systemIDs[id] {
		queue = r.systemQueue
	}
	cause := item.Cause
	if strings.TrimSpace(cause.Kind) == "" {
		cause.Kind = cronstore.CauseSchedule
		if item.Manual {
			cause.Kind = cronstore.CauseManual
		}
	}
	item.Manual = cause.Kind == cronstore.CauseManual
	if item.ChainDepth < 1 {
		item.ChainDepth = 1
	}
	now := r.now()
	item.RunID, item.Cause = r.board.QueueRun(id, cause, now)
	if r.stored(id) {
		if _, err := r.store.RecordRun(context.Background(), cronstore.RunRecord{
			RunID: item.RunID, JobID: id, Status: cronstore.RunStatusQueued, QueuedAt: cronstore.RunTime(now),
			Cause: item.Cause, ChainDepth: item.ChainDepth,
		}); err != nil {
			r.warn("cron_run_record_error", "task_id", id, "error", err.Error())
		}
	}
	select {
	case queue <- item:
		return item.RunID, nil
	default:
		r.board.Done(id)
		r.clearInFlight(id)
		r.recordEnd(id, item.RunID, cronstore.RunStatusSkipped, "", "the run queue was full")
		return "", fmt.Errorf("cron queue is full")
	}
}

// stored reports whether id is a job of the list, whose runs the store records, rather than a
// system task (the heartbeat).
func (r *cronLoopRunner) stored(id string) bool {
	return !r.systemIDs[id]
}

// recordEnd notes in the run history how a stored job's run ended.
func (r *cronLoopRunner) recordEnd(id, runID, status, errText, note string) {
	if !r.stored(id) || runID == "" {
		return
	}
	if err := r.store.MarkRunFinished(context.Background(), runID, status, errText, note, r.now()); err != nil {
		r.warn("cron_run_record_error", "task_id", id, "error", err.Error())
	}
}

func (r *cronLoopRunner) now() time.Time {
	if r.opts.Now != nil {
		return r.opts.Now()
	}
	return time.Now()
}

// worker runs items from queue until it closes. Items still queued at shutdown are logged and
// dropped; a running item gets the cancelled context and is waited for. Each item runs under a
// context of its own, so stopping it (cronstore.StopRun) cancels that execution and no other.
func (r *cronLoopRunner) worker(ctx context.Context, queue <-chan cronstore.DueTask) {
	for item := range queue {
		id := strings.TrimSpace(item.Task.ID)
		if ctx.Err() != nil {
			r.warn("cron_skip", "task_id", id, "reason", "shutdown")
			r.recordEnd(id, item.RunID, cronstore.RunStatusCanceled, "", "the runtime shut down before the run started")
			r.finish(id)
			continue
		}
		r.runItem(ctx, id, item)
	}
}

func (r *cronLoopRunner) runItem(ctx context.Context, id string, item cronstore.DueTask) {
	runCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	if !r.board.Start(id, item.RunID, r.now(), cancel) {
		// Stopped while it waited: it never ran, so its last run stays as it was.
		r.info("cron_run_stopped", "task_id", id, "run_id", item.RunID, "started", false)
		r.recordEnd(id, item.RunID, cronstore.RunStatusCanceled, cronstore.ErrRunStopped.Error(), "stopped before it started")
		r.board.Finish(id, item.RunID, cronstore.RunStatusCanceled, r.now())
		r.clearInFlight(id)
		r.chain(ctx, item, cronstore.RunStatusCanceled)
		return
	}
	stored := r.stored(id)
	if stored {
		if err := r.store.RecordRunStart(id, r.now()); err != nil {
			r.warn("cron_run_record_error", "task_id", id, "error", err.Error())
		}
		if err := r.store.MarkRunStarted(context.Background(), item.RunID, r.now()); err != nil {
			r.warn("cron_run_record_error", "task_id", id, "error", err.Error())
		}
	}
	status := cronstore.RunStatusDone
	errText := ""
	err := r.opts.Run(runCtx, item)
	// From here on a stop is too late: the run's end, not the request, decides how it ended.
	cancel(nil)
	if err != nil {
		if errors.Is(context.Cause(runCtx), cronstore.ErrRunStopped) {
			status = cronstore.RunStatusCanceled
			errText = cronstore.ErrRunStopped.Error()
			r.info("cron_run_stopped", "task_id", id, "run_id", item.RunID, "started", true)
		} else {
			status = cronstore.RunStatusFailed
			errText = err.Error()
			r.warn("cron_task_error", "task_id", id, "error", err.Error())
		}
	}
	if stored {
		if err := r.store.RecordRunResult(id, status); err != nil {
			r.warn("cron_run_record_error", "task_id", id, "error", err.Error())
		}
	}
	r.recordEnd(id, item.RunID, status, errText, "")
	r.board.Finish(id, item.RunID, status, r.now())
	r.clearInFlight(id)
	r.chain(ctx, item, status)
}

func (r *cronLoopRunner) finish(id string) {
	r.board.Done(id)
	r.clearInFlight(id)
}

func (r *cronLoopRunner) markInFlight(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.inFlight[id] {
		return false
	}
	r.inFlight[id] = true
	return true
}

func (r *cronLoopRunner) clearInFlight(id string) {
	r.mu.Lock()
	delete(r.inFlight, id)
	r.mu.Unlock()
}

func (r *cronLoopRunner) warn(msg string, args ...any) {
	if r.opts.Logger != nil {
		r.opts.Logger.Warn(msg, append([]any{"source", strings.TrimSpace(r.opts.Source)}, args...)...)
	}
}

func (r *cronLoopRunner) info(msg string, args ...any) {
	if r.opts.Logger != nil {
		r.opts.Logger.Info(msg, append([]any{"source", strings.TrimSpace(r.opts.Source)}, args...)...)
	}
}

func (r *cronLoopRunner) debug(msg string, args ...any) {
	if r.opts.Logger != nil {
		r.opts.Logger.Debug(msg, append([]any{"source", strings.TrimSpace(r.opts.Source)}, args...)...)
	}
}

func dueSystemTasks(tasks []cronstore.Task, now time.Time) ([]cronstore.DueTask, []error) {
	now = now.UTC()
	out := make([]cronstore.DueTask, 0, len(tasks))
	var errs []error
	seen := map[string]bool{}
	for _, task := range tasks {
		id := strings.TrimSpace(task.ID)
		if id == "" {
			errs = append(errs, fmt.Errorf("system cron task id is required"))
			continue
		}
		if seen[id] {
			errs = append(errs, fmt.Errorf("duplicate system cron task id: %s", id))
			continue
		}
		seen[id] = true
		if !cronstore.TaskEnabled(task) {
			continue
		}
		if err := cronstore.ValidateTask(task); err != nil {
			errs = append(errs, err)
			continue
		}
		due, scheduledAt, err := cronstore.IsDue(task, now)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if due {
			out = append(out, cronstore.DueTask{Task: task, ScheduledAtUTC: scheduledAt})
		}
	}
	return out, errs
}

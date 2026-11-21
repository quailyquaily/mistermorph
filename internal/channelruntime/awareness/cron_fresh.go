package awareness

import (
	"context"
	"fmt"
	"strings"
	"time"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

// DefaultFreshWait is how long a run waits for a "fresh" input that is already queued or running
// elsewhere, before it is recorded as skipped. An input the run starts itself is not bounded by
// it: that run has the task timeout every run has.
const DefaultFreshWait = 30 * time.Minute

const freshPollInterval = 50 * time.Millisecond

// freshen brings the "fresh" inputs of the item's job up to date before the job runs, one after
// the other, in the worker that holds the item. It returns "" when the run may start, or the note
// of the skipped run it becomes.
//
// An input is left alone when the run's chain already has a done run of it (an input is run for a
// fresh result at most once in a chain), or when its latest done run ended within the use's max
// age. Otherwise it is run here, as a run caused by this job in the same chain, and waited for.
// An input that is already queued is run here in its place, and one that is running is waited
// for (at most CronLoopOptions.FreshWait); neither is started twice.
//
// The run is skipped when an input failed, was canceled or was skipped (in this chain or just
// now), is switched off, is gone, would make the chain deeper than cronstore.MaxChainDepth, or
// was not ready in time.
func (r *cronLoopRunner) freshen(ctx context.Context, item cronstore.DueTask) string {
	id := strings.TrimSpace(item.Task.ID)
	inputs := cronstore.FreshInputs(item.Task)
	if len(inputs) == 0 || !r.stored(id) {
		return ""
	}
	origin := strings.TrimSpace(item.Cause.OriginRunID)
	if origin == "" {
		origin = item.RunID
	}
	for _, use := range inputs {
		if r.board.Stopping(id, item.RunID) {
			// Stopped while it waited: the caller ends it as canceled.
			return ""
		}
		if note := r.freshenInput(ctx, item, origin, use); note != "" {
			return note
		}
	}
	return ""
}

// Input states, before a fresh input is run.
const (
	inputStale    = iota // no result that is fresh enough: run it
	inputReady           // a result is there
	inputRunning         // a run of it in this chain is queued or running
	inputUnusable        // the note says why the job cannot start
)

// inputState looks at what the history says of a fresh input: its run in this chain, if it has
// one, and otherwise the age of its latest done run.
func (r *cronLoopRunner) inputState(id, origin string, use cronstore.Use) (int, string) {
	input := strings.TrimSpace(use.JobID)
	background := context.Background()
	unreadable := func(err error) (int, string) {
		r.warn("cron_fresh_error", "task_id", id, "input_job_id", input, "error", err.Error())
		return inputUnusable, fmt.Sprintf("not started: the run history could not be read for input job %s", input)
	}
	runs, err := r.store.ChainRuns(background, origin)
	if err != nil {
		return unreadable(err)
	}
	for i := len(runs) - 1; i >= 0; i-- {
		if runs[i].JobID != input {
			continue
		}
		switch runs[i].Status {
		case cronstore.RunStatusDone:
			return inputReady, ""
		case cronstore.RunStatusQueued, cronstore.RunStatusRunning:
			return inputRunning, ""
		default:
			return inputUnusable, fmt.Sprintf("input job %s %s", input, endedHow(runs[i].Status))
		}
	}
	last, ok, err := r.store.LatestRun(background, input, cronstore.RunStatusDone)
	if err != nil {
		return unreadable(err)
	}
	if ok {
		if finishedAt, err := time.Parse(time.RFC3339, last.FinishedAt); err == nil && r.now().Sub(finishedAt) <= cronstore.FreshMaxAge(use) {
			return inputReady, ""
		}
	}
	return inputStale, ""
}

func (r *cronLoopRunner) freshenInput(ctx context.Context, item cronstore.DueTask, origin string, use cronstore.Use) string {
	id := strings.TrimSpace(item.Task.ID)
	input := strings.TrimSpace(use.JobID)
	switch state, note := r.inputState(id, origin, use); state {
	case inputReady, inputUnusable:
		return note
	case inputRunning:
		return r.awaitInput(ctx, item, input)
	}

	upstream, found, err := r.store.FindByID(input)
	if err != nil {
		r.warn("cron_fresh_error", "task_id", id, "input_job_id", input, "error", err.Error())
		return fmt.Sprintf("not started: input job %s could not be read", input)
	}
	if !found {
		return fmt.Sprintf("not started: input job %s no longer exists", input)
	}
	if !cronstore.TaskEnabled(upstream) {
		return fmt.Sprintf("not started: input job %s is switched off, so it was not run for a fresh result", input)
	}
	depth := item.ChainDepth + 1
	if depth > cronstore.MaxChainDepth {
		return fmt.Sprintf("not started: running input job %s for a fresh result would make the chain more than %d jobs deep", input, cronstore.MaxChainDepth)
	}
	if err := cronstore.ValidateTask(upstream); err != nil {
		return fmt.Sprintf("not started: input job %s is not valid: %s", input, err.Error())
	}

	r.queueMu.RLock()
	closed := r.closed
	r.queueMu.RUnlock()
	if closed || ctx.Err() != nil {
		return fmt.Sprintf("not started: the runtime shut down before input job %s was run", input)
	}
	r.mu.Lock()
	queued, isQueued := r.pending[input]
	free := !r.inFlight[input]
	switch {
	case free:
		r.inFlight[input] = true
	case isQueued:
		delete(r.pending, input)
	}
	r.mu.Unlock()

	var status string
	switch {
	case free:
		// The input is this worker's now. A run of it that another worker made meanwhile is in
		// the history by the time the input was free again: look once more before running it.
		if state, note := r.inputState(id, origin, use); state != inputStale {
			r.clearInFlight(input)
			if state == inputRunning {
				return r.awaitInput(ctx, item, input)
			}
			return note
		}
		run := r.admit(cronstore.DueTask{
			Task:           upstream,
			ScheduledAtUTC: r.now().UTC(),
			Cause: cronstore.RunCause{Kind: cronstore.CauseJob, FromJobID: id, OriginRunID: origin,
				Note: fmt.Sprintf("run for a fresh result that job %s needs", id)},
			ChainDepth: depth,
		})
		r.debug("cron_fresh_run", "task_id", id, "input_job_id", input, "run_id", run.RunID, "origin_run_id", origin)
		status = r.runItem(ctx, input, run)
	case isQueued:
		// Already queued: it runs now, in this worker, instead of when the queue reaches it.
		r.debug("cron_fresh_run_queued", "task_id", id, "input_job_id", input, "run_id", queued.RunID)
		status = r.runItem(ctx, input, queued)
	default:
		return r.awaitInput(ctx, item, input)
	}
	if status != cronstore.RunStatusDone {
		return fmt.Sprintf("input job %s %s", input, endedHow(status))
	}
	return ""
}

// awaitInput waits for the run of input that another worker holds, and says how it ended: "" for
// done.
func (r *cronLoopRunner) awaitInput(ctx context.Context, item cronstore.DueTask, input string) string {
	id := strings.TrimSpace(item.Task.ID)
	limit := r.opts.FreshWait
	if limit <= 0 {
		limit = DefaultFreshWait
	}
	since := r.now().Truncate(time.Second)
	timeout := time.NewTimer(limit)
	defer timeout.Stop()
	poll := time.NewTicker(freshPollInterval)
	defer poll.Stop()
	for r.isInFlight(input) {
		select {
		case <-ctx.Done():
			return fmt.Sprintf("not started: the runtime shut down while input job %s was awaited", input)
		case <-timeout.C:
			return fmt.Sprintf("not started: input job %s was still queued or running after %s", input, limit)
		case <-poll.C:
			if r.board.Stopping(id, item.RunID) {
				return ""
			}
		}
	}
	last, ok, err := r.store.LatestRun(context.Background(), input, cronstore.RunStatusDone, cronstore.RunStatusFailed, cronstore.RunStatusCanceled)
	if err != nil {
		r.warn("cron_fresh_error", "task_id", id, "input_job_id", input, "error", err.Error())
		return fmt.Sprintf("not started: the run history could not be read for input job %s", input)
	}
	finishedAt, parseErr := time.Parse(time.RFC3339, last.FinishedAt)
	if !ok || parseErr != nil || finishedAt.Before(since) {
		return fmt.Sprintf("not started: input job %s ended without a result", input)
	}
	if last.Status != cronstore.RunStatusDone {
		return fmt.Sprintf("input job %s %s", input, endedHow(last.Status))
	}
	return ""
}

func (r *cronLoopRunner) isInFlight(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.inFlight[id]
}

package awareness

import (
	"context"
	"errors"
	"fmt"
	"strings"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// chain follows a finished run of a stored job to the jobs that use it with mode "each".
//
// A run that ended done queues each of them, as a run caused by this job, in the same chain (the
// same origin run). A job that joins "all" of several "each" inputs waits until every one of them
// has a done run in the chain, and is then queued once; one that joins "any" is queued by each.
// A run that failed or was canceled starts nothing: a skipped run is recorded for each job that
// uses it, saying which input did not finish, and for the jobs down the chain from those.
//
// A job that is switched off is never queued (a skipped run says so), and a chain goes at most
// cronstore.MaxChainDepth jobs deep (a skipped run says where it stopped).
func (r *cronLoopRunner) chain(ctx context.Context, item cronstore.DueTask, status string) {
	id := strings.TrimSpace(item.Task.ID)
	if !r.stored(id) {
		return
	}
	r.chainMu.Lock()
	defer r.chainMu.Unlock()
	tasks, err := r.store.Tasks(context.Background())
	if err != nil {
		r.warn("cron_chain_error", "task_id", id, "error", err.Error())
		return
	}
	dependents := cronstore.EachDependents(tasks, id)
	if len(dependents) == 0 {
		return
	}
	link := chainLink{from: id, origin: strings.TrimSpace(item.Cause.OriginRunID), depth: item.ChainDepth + 1}
	if link.origin == "" {
		link.origin = item.RunID
	}
	if item.ChainDepth < 1 {
		link.depth = 2
	}
	if status == cronstore.RunStatusDone {
		for _, dependent := range dependents {
			r.chainStart(ctx, tasks, dependent, link)
		}
		return
	}
	how := "failed"
	if status == cronstore.RunStatusCanceled {
		how = "was canceled"
	}
	seen := map[string]bool{}
	for _, dependent := range dependents {
		r.chainSkip(tasks, dependent, link, fmt.Sprintf("input job %s %s", id, how), seen)
	}
}

// chainLink is the step from a finished run to a job that uses it: the job the run was of, the
// chain's origin run, and the depth the next job would run at.
type chainLink struct {
	from   string
	origin string
	depth  int
}

// chainStart queues task after its input link.from ended done, when its join lets it.
func (r *cronLoopRunner) chainStart(ctx context.Context, tasks []cronstore.Task, task cronstore.Task, link chainLink) {
	id := strings.TrimSpace(task.ID)
	if !cronstore.TaskEnabled(task) {
		r.recordSkip(id, link, "not started: the job is switched off")
		next := chainLink{from: id, origin: link.origin, depth: link.depth + 1}
		seen := map[string]bool{id: true}
		for _, dependent := range cronstore.EachDependents(tasks, id) {
			r.chainSkip(tasks, dependent, next, fmt.Sprintf("input job %s was skipped", id), seen)
		}
		return
	}
	if link.depth > cronstore.MaxChainDepth {
		r.recordSkip(id, link, fmt.Sprintf("not started: the chain would be more than %d jobs deep", cronstore.MaxChainDepth))
		return
	}
	if inputs := cronstore.EachInputs(task); len(inputs) > 1 && cronstore.JoinForTask(task) == cronstore.JoinAll {
		runs, err := r.store.ChainRuns(context.Background(), link.origin)
		if err != nil {
			r.warn("cron_chain_error", "task_id", id, "error", err.Error())
			return
		}
		done := map[string]bool{}
		for _, run := range runs {
			if run.Status == cronstore.RunStatusDone {
				done[run.JobID] = true
			}
			// The chain already started this job once, when its last input ended.
			if run.JobID == id && run.Cause.Kind == cronstore.CauseJob && run.Status != cronstore.RunStatusSkipped {
				return
			}
		}
		for _, input := range inputs {
			if !done[input] {
				r.debug("cron_chain_wait", "task_id", id, "from_job_id", link.from, "waiting_for", input)
				return
			}
		}
	}
	_, err := r.enqueue(ctx, cronstore.DueTask{
		Task:           task,
		ScheduledAtUTC: r.now().UTC(),
		Cause:          cronstore.RunCause{Kind: cronstore.CauseJob, FromJobID: link.from, OriginRunID: link.origin},
		ChainDepth:     link.depth,
	})
	switch {
	case err == nil:
		r.debug("cron_chain_queued", "task_id", id, "from_job_id", link.from, "origin_run_id", link.origin)
	case errors.Is(err, daemonruntime.ErrCronBusy):
		r.recordSkip(id, link, "not started: the job was already queued or running")
	case errors.Is(err, context.Canceled):
		r.debug("cron_skip", "task_id", id, "reason", "shutdown")
	case strings.Contains(err.Error(), "queue is full"):
		// enqueue recorded the skipped run.
		r.warn("cron_skip", "task_id", id, "reason", "queue_full")
	default:
		r.recordSkip(id, link, "not started: "+err.Error())
	}
}

// chainSkip records a skipped run for task, whose input did not finish, and for the jobs down the
// chain from it. seen keeps a job reached by two paths to one record.
func (r *cronLoopRunner) chainSkip(tasks []cronstore.Task, task cronstore.Task, link chainLink, note string, seen map[string]bool) {
	id := strings.TrimSpace(task.ID)
	if seen[id] || link.depth > cronstore.MaxChainDepth {
		return
	}
	seen[id] = true
	r.recordSkip(id, link, note)
	next := chainLink{from: id, origin: link.origin, depth: link.depth + 1}
	for _, dependent := range cronstore.EachDependents(tasks, id) {
		r.chainSkip(tasks, dependent, next, fmt.Sprintf("input job %s was skipped", id), seen)
	}
}

// recordSkip adds a skipped run of job id to the run history: the chain reached it and did not
// start it, for the reason note gives.
func (r *cronLoopRunner) recordSkip(id string, link chainLink, note string) {
	now := cronstore.RunTime(r.now())
	_, err := r.store.RecordRun(context.Background(), cronstore.RunRecord{
		JobID: id, Status: cronstore.RunStatusSkipped, QueuedAt: now, FinishedAt: now,
		Cause:      cronstore.RunCause{Kind: cronstore.CauseJob, FromJobID: link.from, OriginRunID: link.origin, Note: note},
		ChainDepth: link.depth,
	})
	if err != nil {
		r.warn("cron_run_record_error", "task_id", id, "error", err.Error())
		return
	}
	r.info("cron_chain_skip", "task_id", id, "from_job_id", link.from, "origin_run_id", link.origin, "reason", note)
}

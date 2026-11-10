package runtimecontrol

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultSteerReplyTimeout     = 60 * time.Second
	defaultSteerReplyConcurrency = 4
)

// SteerReplyStatus says what a SteerReply tells.
type SteerReplyStatus string

const (
	// SteerReplied: a model's reply to input that reached the run.
	SteerReplied SteerReplyStatus = "replied"
	// SteerReplyFailed: input reached the run, but no reply could be written to it.
	SteerReplyFailed SteerReplyStatus = "reply_failed"
	// SteerNotQueued: input did not reach the run (finishing, stopping, or too many waiting).
	SteerNotQueued SteerReplyStatus = "not_queued"
	// SteerNotApplied: input was queued, but the run ended or was stopped before it took it in.
	SteerNotApplied SteerReplyStatus = "not_applied"
)

// SteerReply is the reply to one input steered into an active run.
type SteerReply struct {
	TaskID string
	Input  string
	Text   string
	Status SteerReplyStatus
	// Followup is set on the notice given when a run drops input after its reply was delivered.
	Followup bool
	Err      error
}

// SteerDeliverFunc shows reply to the person who sent the input.
type SteerDeliverFunc func(ctx context.Context, reply SteerReply) error

type SteerResponderOptions struct {
	Logger *slog.Logger
	// Timeout bounds writing one reply; 0 is 60s.
	Timeout time.Duration
	// Concurrency bounds the replies written at once across conversations; 0 is 4.
	Concurrency int
}

// SteerResponder replies to input steered into active runs: the input reaches the run as before,
// and the person gets a reply written by a model from the run's task, conversation and progress.
// Replies to one conversation are written and delivered one at a time, in the order the inputs
// came; each input gets one reply. The reply says what happened to input that did not reach the
// run, or that a reply could not be written, instead of an emoji.
type SteerResponder struct {
	ctx         context.Context
	generate    SteerReplyFunc
	logger      *slog.Logger
	timeout     time.Duration
	concurrency chan struct{}

	mu    sync.Mutex
	lanes map[runKey]*steerLane
	// work counts replies not yet delivered; watchers, inputs replied to that a run may still drop.
	work     sync.WaitGroup
	watchers sync.WaitGroup
}

type steerLane struct {
	jobs []steerJob
}

type steerJob struct {
	result  SteerResult
	deliver SteerDeliverFunc
}

// NewSteerResponder returns a responder that writes replies with generate until ctx ends.
func NewSteerResponder(ctx context.Context, generate SteerReplyFunc, opts SteerResponderOptions) *SteerResponder {
	if ctx == nil {
		ctx = context.Background()
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultSteerReplyTimeout
	}
	concurrency := opts.Concurrency
	if concurrency <= 0 {
		concurrency = defaultSteerReplyConcurrency
	}
	return &SteerResponder{
		ctx:         ctx,
		generate:    generate,
		logger:      logger,
		timeout:     timeout,
		concurrency: make(chan struct{}, concurrency),
		lanes:       map[runKey]*steerLane{},
	}
}

// Respond replies to the input result tells of, through deliver, in the background. It returns
// ErrNoActiveRun for a result that found no active run, and ErrSteerInputEmpty for one without
// input: such input was not steered, and the caller handles it as before.
func (r *SteerResponder) Respond(result SteerResult, deliver SteerDeliverFunc) error {
	if !result.Found || result.entry == nil {
		return ErrNoActiveRun
	}
	if strings.TrimSpace(result.input) == "" {
		return ErrSteerInputEmpty
	}
	if deliver == nil {
		return errSteerResponderMissing
	}
	if r == nil {
		// Without a responder there is no model to write the reply: say so instead.
		r = NewSteerResponder(context.Background(), nil, SteerResponderOptions{})
	}
	key := runKey{runtime: result.entry.Runtime, conversationKey: result.entry.ConversationKey}
	r.mu.Lock()
	lane := r.lanes[key]
	start := lane == nil
	if start {
		lane = &steerLane{}
		r.lanes[key] = lane
	}
	lane.jobs = append(lane.jobs, steerJob{result: result, deliver: deliver})
	r.work.Add(1)
	r.mu.Unlock()
	if start {
		go r.runLane(key, lane)
	}
	return nil
}

// Wait waits until the replies to the inputs given to Respond so far are delivered. A notice of
// input a run drops later comes after it.
func (r *SteerResponder) Wait() {
	if r != nil {
		r.work.Wait()
	}
}

func (r *SteerResponder) runLane(key runKey, lane *steerLane) {
	for {
		r.mu.Lock()
		if len(lane.jobs) == 0 {
			delete(r.lanes, key)
			r.mu.Unlock()
			return
		}
		// Inputs are numbered as they reach the run; answer them in that order.
		sort.SliceStable(lane.jobs, func(i, j int) bool { return lane.jobs[i].result.seq < lane.jobs[j].result.seq })
		job := lane.jobs[0]
		lane.jobs = lane.jobs[1:]
		r.mu.Unlock()
		r.handle(job)
	}
}

func (r *SteerResponder) handle(job steerJob) {
	defer r.work.Done()
	result := job.result
	reply := SteerReply{TaskID: result.TaskID, Input: result.input}
	switch {
	case !result.Queued:
		reply.Status, reply.Text = SteerNotQueued, SteerRejectedText(result.Reason)
	case dropped(result.ticket):
		reply.Status, reply.Text = SteerNotApplied, steerNotAppliedText(result.ticket.Outcome())
	default:
		reply = r.write(result)
		if reply.Status == SteerReplied && dropped(result.ticket) {
			// The run ended while the reply was written: the reply would promise what will not happen.
			reply.Status, reply.Text = SteerNotApplied, steerNotAppliedText(result.ticket.Outcome())
		}
	}
	if !r.deliver(job.deliver, reply) {
		return
	}
	if reply.Status == SteerReplied || reply.Status == SteerReplyFailed {
		if reply.Status == SteerReplied {
			result.control.recordSteerExchange(result.entry, result.input, reply.Text)
		}
		if result.ticket != nil && result.ticket.Outcome() == SteerPending {
			r.watchers.Add(1)
			go r.watch(job, reply)
		}
	}
}

// watch tells the person when a run that got a reply's input drops it, instead of taking it in.
func (r *SteerResponder) watch(job steerJob, replied SteerReply) {
	defer r.watchers.Done()
	select {
	case <-job.result.ticket.Done():
	case <-r.ctx.Done():
		return
	}
	if job.result.ticket.Outcome() != SteerDropped {
		// Taken in; or stopped, which the stop's own reply already tells.
		return
	}
	r.deliver(job.deliver, SteerReply{
		TaskID:   replied.TaskID,
		Input:    replied.Input,
		Text:     steerNotAppliedFollowupText(replied.Input),
		Status:   SteerNotApplied,
		Followup: true,
	})
}

func (r *SteerResponder) write(result SteerResult) SteerReply {
	reply := SteerReply{TaskID: result.TaskID, Input: result.input}
	fail := func(err error) SteerReply {
		r.logger.Warn("steer_reply_failed", "task_id", result.TaskID, "answered", result.Answered, "error", err.Error())
		reply.Status, reply.Err, reply.Text = SteerReplyFailed, err, steerReplyFailedText(result.Answered, err)
		return reply
	}
	if r.generate == nil {
		return fail(errSteerReplyUnavailable)
	}
	select {
	case r.concurrency <- struct{}{}:
	case <-r.ctx.Done():
		return fail(r.ctx.Err())
	}
	defer func() { <-r.concurrency }()
	ctx, cancel := context.WithTimeout(r.ctx, r.timeout)
	defer cancel()
	text, err := r.generate(ctx, result.control.steerReplyRequest(result))
	if err != nil {
		return fail(err)
	}
	text, err = MeaningfulSteerReply(text)
	if err != nil {
		return fail(err)
	}
	reply.Status, reply.Text = SteerReplied, text
	return reply
}

func (r *SteerResponder) deliver(deliver SteerDeliverFunc, reply SteerReply) bool {
	if r.ctx.Err() != nil {
		r.logger.Info("steer_reply_dropped", "task_id", reply.TaskID, "reason", "runtime closed")
		return false
	}
	ctx, cancel := context.WithTimeout(r.ctx, r.timeout)
	defer cancel()
	if err := deliver(ctx, reply); err != nil {
		r.logger.Warn("steer_reply_deliver_failed", "task_id", reply.TaskID, "status", string(reply.Status), "error", err.Error())
		return false
	}
	return true
}

func dropped(ticket *SteerTicket) bool {
	outcome := ticket.Outcome()
	return outcome == SteerDropped || outcome == SteerStopped
}

var (
	errSteerReplyUnavailable = errors.New("no model is available to write it")
	errSteerResponderMissing = errors.New("steer deliver func is nil")
)

func (c *RunControl) steerReplyRequest(result SteerResult) SteerReplyRequest {
	entry := result.entry
	req := SteerReplyRequest{
		TaskID:   result.TaskID,
		Input:    result.input,
		Answered: result.Answered,
		Question: result.question,
		Applied:  result.ticket.Outcome() == SteerApplied,
	}
	if entry == nil {
		return req
	}
	req.Runtime, req.ConversationKey = entry.Runtime, entry.ConversationKey
	req.Task = entry.Task
	req.Conversation = append([]ConversationLine(nil), entry.Conversation...)
	if !entry.startedAt.IsZero() {
		req.Elapsed = time.Since(entry.startedAt)
	}
	req.Progress = snapshotFor(entry)
	if c != nil {
		c.mu.Lock()
		req.Earlier = append([]SteerExchange(nil), entry.steerLog...)
		c.mu.Unlock()
	}
	return req
}

func (c *RunControl) recordSteerExchange(entry *activeRun, input string, reply string) {
	if c == nil || entry == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry.steerLog = append(entry.steerLog, SteerExchange{Message: input, Reply: reply})
	if len(entry.steerLog) > steerReplyExchangeLimit {
		entry.steerLog = append([]SteerExchange(nil), entry.steerLog[len(entry.steerLog)-steerReplyExchangeLimit:]...)
	}
}

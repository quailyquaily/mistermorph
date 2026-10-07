package codemode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Calcium-Ion/moejs"
)

const sourceName = "codemode.js"

// finishGrace is how long cancelled operations get to return once the invocation is over.
const finishGrace = 5 * time.Second

var (
	errOutputLimit = errors.New("output limit reached")
	errMemoryLimit = errors.New("memory limit reached")
)

// Run executes code as the body of an async function and returns how it ended. It never returns
// an error: every failure is a Result status.
func Run(ctx context.Context, code string, host Host, limits Limits, watcher *MemoryWatcher) Result {
	started := time.Now()
	inv := &invocation{host: host, limits: limits, result: Result{Output: []string{}, Ops: []OpRecord{}}}
	inv.run(ctx, code, watcher)
	inv.result.Elapsed = time.Since(started)
	return inv.result
}

type invocation struct {
	host   Host
	limits Limits
	result Result

	rt *moejs.Runtime
	// opsCtx bounds host operations: the deadline, the task's cancellation and the memory
	// watcher end it. ctx, its child, also ends when the script must stop for other reasons,
	// such as the output limit, while started operations may still finish.
	opsCtx     context.Context
	cancelOps  context.CancelCauseFunc
	ctx        context.Context
	cancel     context.CancelCauseFunc
	queue      []*pendingOp
	running    map[int]*pendingOp
	done       chan opDone
	issued     int
	resultSize int
	outputSize int
	stop       error
	unhandled  map[moejs.Value]moejs.Value
}

type pendingOp struct {
	op      Op
	safe    bool
	resolve func(moejs.Value) error
	started time.Time
}

type opDone struct {
	index  int
	result string
	err    error
}

func (inv *invocation) run(parent context.Context, code string, watcher *MemoryWatcher) {
	if strings.TrimSpace(code) == "" {
		inv.fail("code is required")
		return
	}
	if len(code) > MaxSourceBytes {
		inv.fail(fmt.Sprintf("code is longer than %d bytes", MaxSourceBytes))
		return
	}
	if strings.HasPrefix(strings.TrimSpace(code), "```") {
		inv.fail("SyntaxError: code is wrapped in a Markdown fence; pass the JavaScript alone")
		return
	}
	if !utf8.ValidString(code) {
		inv.fail("code is not valid UTF-8")
		return
	}
	if err := validLimits(inv.limits); err != nil {
		inv.fail(err.Error())
		return
	}
	mod, err := moejs.Compile(sourceName, prelude+code+"\n}")
	if err != nil {
		inv.fail(scriptError(err))
		return
	}

	timeoutCtx, cancelTimeout := context.WithTimeout(parent, inv.limits.Timeout)
	defer cancelTimeout()
	opsCtx, cancelOps := context.WithCancelCause(timeoutCtx)
	defer cancelOps(nil)
	ctx, cancel := context.WithCancelCause(opsCtx)
	defer cancel(nil)
	inv.opsCtx, inv.cancelOps = opsCtx, cancelOps
	inv.ctx, inv.cancel = ctx, cancel
	if ctx.Err() != nil {
		inv.endFromContext()
		return
	}

	rt := moejs.NewRuntime(moejs.Options{DisableDynamicCode: true})
	inv.rt = rt
	stopInterrupt := context.AfterFunc(ctx, func() { rt.Interrupt(context.Cause(ctx)) })
	defer stopInterrupt()
	if watcher != nil {
		unwatch := watcher.watch(func() { cancelOps(errMemoryLimit) })
		defer func() { inv.result.Memory = unwatch() }()
	}
	inv.running = map[int]*pendingOp{}
	inv.done = make(chan opDone, max(inv.limits.MaxToolCalls, 1))
	inv.unhandled = map[moejs.Value]moejs.Value{}
	rt.SetPromiseRejectionTracker(func(p moejs.Value, op moejs.PromiseRejectionOperation) {
		if op == moejs.PromiseRejectionReject {
			state, reason, _ := moejs.PromiseResult(p)
			if state == moejs.PromiseRejected {
				inv.unhandled[p] = reason
			}
			return
		}
		delete(inv.unhandled, p)
	})

	if err := rt.Load(mod); err != nil {
		inv.endWithError(err)
		return
	}
	hostObject, err := rt.FromGo(map[string]any{
		"call":     rt.Function("call", 2, inv.nativeCall),
		"search":   rt.Function("search", 2, inv.nativeSearch),
		"describe": rt.Function("describe", 1, inv.nativeDescribe),
		"text":     rt.Function("text", 1, inv.nativeText),
	})
	if err != nil {
		inv.fail(err.Error())
		return
	}
	initHook, _ := mod.Hook("__init")
	if _, err := rt.Call(initHook, hostObject); err != nil {
		inv.endWithError(err)
		return
	}
	mainHook, _ := mod.Hook("main")
	entry, err := rt.Call(mainHook)
	if err != nil {
		inv.endWithError(err)
		return
	}
	inv.loop(entry)
}

// loop dispatches operations and settles their promises until the entry promise settles or the
// invocation stops.
func (inv *invocation) loop(entry moejs.Value) {
	for {
		if inv.stop != nil {
			inv.finishOutstanding()
			return
		}
		state, value, _ := moejs.PromiseResult(entry)
		switch state {
		case moejs.PromiseFulfilled:
			inv.finishOutstanding()
			if inv.result.Status == "" {
				inv.completeOrUnhandled()
			}
			return
		case moejs.PromiseRejected:
			delete(inv.unhandled, entry)
			inv.finishOutstanding()
			if inv.result.Status == "" {
				inv.fail(inv.describeThrown(value))
			}
			return
		}
		inv.dispatch()
		if inv.stop != nil {
			continue
		}
		// An operation rejected while dispatching ran the script on; it may have settled.
		if state, _, _ := moejs.PromiseResult(entry); state != moejs.PromisePending {
			continue
		}
		if len(inv.running) == 0 {
			inv.finishOutstanding()
			inv.fail("the script is waiting on a promise that nothing will settle")
			return
		}
		select {
		case done := <-inv.done:
			inv.settle(done)
		case <-inv.ctx.Done():
			inv.endFromContext()
			return
		}
	}
}

// dispatch starts queued operations in issue order. A parallel-safe operation may overlap other
// parallel-safe ones up to MaxParallel; any other operation runs alone and holds back everything
// issued after it.
func (inv *invocation) dispatch() {
	for len(inv.queue) > 0 && inv.stop == nil {
		next := inv.queue[0]
		if next.safe {
			if len(inv.running) >= inv.limits.MaxParallel || inv.runningUnsafe() {
				return
			}
		} else if len(inv.running) > 0 {
			return
		}
		inv.queue = inv.queue[1:]
		inv.start(next)
	}
}

func (inv *invocation) runningUnsafe() bool {
	for _, p := range inv.running {
		if !p.safe {
			return true
		}
	}
	return false
}

func (inv *invocation) start(p *pendingOp) {
	decision := inv.host.Check(inv.opsCtx, p.op)
	switch decision.Kind {
	case Reject:
		inv.record(p.op, OutcomeDenied, decision.Message, 0)
		inv.resolveFailure(p, decision.Message)
		return
	case RequireApproval:
		inv.record(p.op, OutcomeRequiresApproval, decision.Message, 0)
		inv.result.Pending = &PendingCall{Tool: p.op.Tool, Args: p.op.Args}
		inv.result.Status = StatusRequiresDirectCall
		inv.result.Error = "call " + p.op.Tool + " directly with these arguments; it needs approval and cannot run inside a script"
		inv.stop = errRequiresApproval
		return
	}
	p.started = time.Now()
	inv.running[p.op.Index] = p
	go func(op Op) {
		result, err := inv.host.Run(inv.opsCtx, op)
		inv.done <- opDone{index: op.Index, result: result, err: err}
	}(p.op)
}

var errRequiresApproval = errors.New("requires a direct call")

func (inv *invocation) settle(done opDone) {
	p := inv.running[done.index]
	delete(inv.running, done.index)
	result, err := inv.host.Finish(inv.opsCtx, p.op, done.result, done.err)
	duration := time.Since(p.started)
	if err != nil {
		inv.record(p.op, OutcomeFailed, err.Error(), duration)
		inv.resolveFailure(p, err.Error())
		return
	}
	if len(result) > MaxResultBytes {
		message := fmt.Sprintf("result is longer than %d bytes; the operation ran, but its result is not available to the script", MaxResultBytes)
		inv.record(p.op, OutcomeSucceeded, message, duration)
		inv.resolveFailure(p, message)
		return
	}
	if inv.resultSize+len(result) > MaxTotalResultBytes {
		message := fmt.Sprintf("results of this script passed %d bytes; the operation ran, but its result is not available to the script", MaxTotalResultBytes)
		inv.record(p.op, OutcomeSucceeded, message, duration)
		inv.resolveFailure(p, message)
		return
	}
	inv.resultSize += len(result)
	inv.record(p.op, OutcomeSucceeded, "", duration)
	inv.resolveValue(p, map[string]any{"ok": true, "value": result})
}

func (inv *invocation) resolveFailure(p *pendingOp, message string) {
	inv.resolveValue(p, map[string]any{"ok": false, "error": message})
}

func (inv *invocation) resolveValue(p *pendingOp, value map[string]any) {
	v, err := inv.rt.FromGo(value)
	if err == nil {
		err = p.resolve(v)
	}
	if err != nil {
		inv.stopWithError(err)
	}
}

// finishOutstanding drops queued operations and lets started ones finish: within the deadline
// when the script ended on its own, or after cancelling them when the invocation was cut short.
// Their results reach the host but never the script.
func (inv *invocation) finishOutstanding() {
	for _, p := range inv.queue {
		inv.record(p.op, OutcomeNotStarted, "", 0)
	}
	inv.queue = nil
	if len(inv.running) == 0 {
		return
	}
	for len(inv.running) > 0 && inv.opsCtx.Err() == nil {
		select {
		case done := <-inv.done:
			inv.finishUnseen(done, OutcomeSucceeded)
		case <-inv.opsCtx.Done():
		}
	}
	if len(inv.running) == 0 {
		return
	}
	// Cut short: the operations' context is cancelled.
	grace := time.NewTimer(finishGrace)
	defer grace.Stop()
	for len(inv.running) > 0 {
		select {
		case done := <-inv.done:
			inv.finishUnseen(done, OutcomeCancelled)
		case <-grace.C:
			for index, p := range inv.running {
				delete(inv.running, index)
				_, _ = inv.host.Finish(context.WithoutCancel(inv.opsCtx), p.op, "", context.Cause(inv.opsCtx))
				inv.record(p.op, OutcomeCancelled, "did not return after cancellation; outcome unknown", time.Since(p.started))
			}
			return
		}
	}
}

func (inv *invocation) finishUnseen(done opDone, outcome Outcome) {
	p := inv.running[done.index]
	delete(inv.running, done.index)
	finishCtx := inv.opsCtx
	if finishCtx.Err() != nil {
		finishCtx = context.WithoutCancel(finishCtx)
	}
	_, err := inv.host.Finish(finishCtx, p.op, done.result, done.err)
	message := ""
	switch {
	case err != nil && outcome == OutcomeCancelled:
		message = err.Error() + "; outcome unknown"
	case err != nil:
		outcome, message = OutcomeFailed, err.Error()
	}
	inv.record(p.op, outcome, message, time.Since(p.started))
}

func (inv *invocation) record(op Op, outcome Outcome, message string, duration time.Duration) {
	inv.result.Ops = append(inv.result.Ops, OpRecord{
		Index: op.Index, Kind: op.Kind, Tool: op.Tool, Query: op.Query,
		Outcome: outcome, Error: message, Duration: duration,
	})
}

// issue queues a host operation and returns its promise.
func (inv *invocation) issue(op Op) (moejs.Value, error) {
	p, resolve, _ := inv.rt.NewPromise()
	op.Index = inv.issued
	inv.issued++
	pending := &pendingOp{op: op, resolve: resolve}
	if inv.issued > inv.limits.MaxToolCalls {
		message := fmt.Sprintf("this script already made %d tool operations, its limit", inv.limits.MaxToolCalls)
		inv.record(op, OutcomeDenied, message, 0)
		inv.resolveFailure(pending, message)
		return p, nil
	}
	pending.safe = inv.host.ParallelSafe(op)
	inv.queue = append(inv.queue, pending)
	return p, nil
}

func (inv *invocation) nativeCall(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	name, err := inv.stringArg(args, 0)
	if err != nil {
		return moejs.Value{}, err
	}
	raw, err := inv.stringArg(args, 1)
	if err != nil {
		return moejs.Value{}, err
	}
	if len(raw) > MaxArgBytes {
		return moejs.Value{}, fmt.Errorf("arguments of %s are longer than %d bytes", name, MaxArgBytes)
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(raw), &params); err != nil || params == nil {
		return moejs.Value{}, fmt.Errorf("arguments of %s must be a JSON object", name)
	}
	return inv.issue(Op{Kind: OpCall, Tool: name, Args: params, ArgsJSON: raw})
}

func (inv *invocation) nativeSearch(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	query, err := inv.stringArg(args, 0)
	if err != nil {
		return moejs.Value{}, err
	}
	raw, err := inv.stringArg(args, 1)
	if err != nil {
		return moejs.Value{}, err
	}
	var options struct {
		Server string `json:"server"`
		Limit  int    `json:"limit"`
	}
	if err := json.Unmarshal([]byte(raw), &options); err != nil {
		return moejs.Value{}, fmt.Errorf("searchTools options must be {server, limit}")
	}
	return inv.issue(Op{Kind: OpSearch, Query: query, Server: strings.TrimSpace(options.Server), Limit: options.Limit})
}

func (inv *invocation) nativeDescribe(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	name, err := inv.stringArg(args, 0)
	if err != nil {
		return moejs.Value{}, err
	}
	return inv.issue(Op{Kind: OpDescribe, Tool: name})
}

// nativeText appends one output item. Passing the output limit stops the script: it is not an
// exception the script could catch to keep going.
func (inv *invocation) nativeText(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	item, err := inv.stringArg(args, 0)
	if err != nil {
		return moejs.Value{}, err
	}
	if len(inv.result.Output) >= MaxOutputItems || inv.outputSize+len(item) > MaxOutputBytes {
		inv.cancel(errOutputLimit)
		inv.rt.Interrupt(errOutputLimit)
		return moejs.Value{}, nil
	}
	inv.outputSize += len(item)
	inv.result.Output = append(inv.result.Output, item)
	return moejs.Value{}, nil
}

func (inv *invocation) stringArg(args []moejs.Value, i int) (string, error) {
	v := moejs.Arg(args, i)
	if !v.IsString() {
		return "", fmt.Errorf("argument %d must be a string", i+1)
	}
	out, err := inv.rt.ToGo(v)
	if err != nil {
		return "", err
	}
	s, _ := out.(string)
	return s, nil
}

func (inv *invocation) completeOrUnhandled() {
	for _, reason := range inv.unhandled {
		inv.fail("unhandled promise rejection: " + inv.describeThrown(reason))
		return
	}
	inv.result.Status = StatusCompleted
}

func (inv *invocation) fail(message string) {
	inv.result.Status = StatusFailed
	inv.result.Error = message
}

// stopWithError ends the loop after JavaScript returned an error while settling a promise.
func (inv *invocation) stopWithError(err error) {
	if inv.stop != nil {
		return
	}
	inv.stop = err
	inv.endWithError(err)
}

func (inv *invocation) endWithError(err error) {
	var interrupted *moejs.InterruptedError
	if errors.As(err, &interrupted) {
		inv.endFromContext()
		return
	}
	var exc *moejs.Exception
	if errors.As(err, &exc) {
		inv.fail(inv.exceptionText(exc))
		return
	}
	inv.fail(scriptError(err))
}

// endFromContext sets the status of an invocation that its context, the output limit or the
// memory watcher ended.
func (inv *invocation) endFromContext() {
	if inv.stop == nil {
		inv.stop = context.Canceled
	}
	if inv.ctx == nil {
		inv.result.Status = StatusCancelled
		return
	}
	cause := context.Cause(inv.ctx)
	switch {
	case errors.Is(cause, errOutputLimit):
		inv.result.Status = StatusOutputLimit
		inv.result.Error = fmt.Sprintf("output passed %d bytes or %d items", MaxOutputBytes, MaxOutputItems)
	case errors.Is(cause, errMemoryLimit):
		inv.result.Status = StatusMemoryLimit
		inv.result.Error = "the process passed its memory ceiling while scripts ran"
	case errors.Is(cause, context.DeadlineExceeded):
		inv.result.Status = StatusTimedOut
		inv.result.Error = "the script did not finish before its deadline"
	default:
		inv.result.Status = StatusCancelled
		inv.result.Error = "the task was cancelled"
	}
	inv.finishOutstanding()
}

func validLimits(l Limits) error {
	if l.Timeout <= 0 || l.MaxToolCalls <= 0 || l.MaxParallel <= 0 {
		return fmt.Errorf("codemode limits must be positive")
	}
	return nil
}

func (inv *invocation) describeThrown(value moejs.Value) string {
	if value.IsObject() {
		name, _ := inv.rt.Get(value, "name")
		message, _ := inv.rt.Get(value, "message")
		if message.IsString() {
			text := inv.goString(message)
			if n := inv.goString(name); n != "" {
				text = n + ": " + text
			}
			if stack, _ := inv.rt.Get(value, "stack"); stack.IsString() {
				if line := scriptLine(inv.goString(stack)); line > 0 {
					text += " (line " + strconv.Itoa(line) + ")"
				}
			}
			return text
		}
	}
	var buf bytes.Buffer
	if out, err := inv.rt.AppendJSON(nil, value); err == nil {
		buf.Write(out)
	}
	if buf.Len() == 0 {
		return inv.goString(value)
	}
	return buf.String()
}

// goString reads a JavaScript string; other values give "".
func (inv *invocation) goString(v moejs.Value) string {
	if !v.IsString() {
		return ""
	}
	out, _ := inv.rt.ToGo(v)
	s, _ := out.(string)
	return s
}

func (inv *invocation) exceptionText(exc *moejs.Exception) string {
	text := exc.Name() + ": " + exc.Message()
	if line := scriptLine(inv.rt.StackTrace(exc)); line > 0 {
		text += " (line " + strconv.Itoa(line) + ")"
	}
	return text
}

var stackPosition = regexp.MustCompile(regexp.QuoteMeta(sourceName) + `:(\d+):(\d+)`)

// scriptLine is the first stack frame inside the script, as a line of the script itself.
func scriptLine(stack string) int {
	for _, m := range stackPosition.FindAllStringSubmatch(stack, -1) {
		line, _ := strconv.Atoi(m[1])
		if line > preludeLines {
			return line - preludeLines
		}
	}
	return 0
}

// scriptError reports a compile error at the script's own line and column.
func scriptError(err error) string {
	var syntax *moejs.SyntaxError
	if errors.As(err, &syntax) {
		line, column := syntax.Line-preludeLines, syntax.Column
		if line == 1 {
			column -= preludeColumns
		}
		if line < 1 {
			return "SyntaxError: " + syntax.Message
		}
		return fmt.Sprintf("SyntaxError: %s (line %d, column %d)", syntax.Message, line, column)
	}
	return err.Error()
}

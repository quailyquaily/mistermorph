package codemode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeTool func(ctx context.Context, args map[string]any) (string, error)

type fakeHost struct {
	tools     map[string]fakeTool
	safe      map[string]bool
	decisions map[string]Decision
	finish    func(op Op, result string, err error) (string, error)

	mu       sync.Mutex
	calls    []Op
	finished []string
	running  int32
	peak     int32
}

func (h *fakeHost) Check(_ context.Context, op Op) Decision {
	if d, ok := h.decisions[op.Tool]; ok {
		return d
	}
	if op.Kind == OpCall {
		if _, ok := h.tools[op.Tool]; !ok {
			return Decision{Kind: Reject, Message: "unknown tool " + op.Tool}
		}
	}
	return Decision{Kind: Allow}
}

func (h *fakeHost) ParallelSafe(op Op) bool { return h.safe[op.Tool] }

func (h *fakeHost) Run(ctx context.Context, op Op) (string, error) {
	n := atomic.AddInt32(&h.running, 1)
	defer atomic.AddInt32(&h.running, -1)
	for {
		peak := atomic.LoadInt32(&h.peak)
		if n <= peak || atomic.CompareAndSwapInt32(&h.peak, peak, n) {
			break
		}
	}
	h.mu.Lock()
	h.calls = append(h.calls, op)
	h.mu.Unlock()
	switch op.Kind {
	case OpSearch:
		return fmt.Sprintf(`{"query":%q,"server":%q,"limit":%d}`, op.Query, op.Server, op.Limit), nil
	case OpDescribe:
		return fmt.Sprintf(`{"name":%q}`, op.Tool), nil
	}
	return h.tools[op.Tool](ctx, op.Args)
}

func (h *fakeHost) Finish(_ context.Context, op Op, result string, err error) (string, error) {
	h.mu.Lock()
	h.finished = append(h.finished, op.Tool)
	h.mu.Unlock()
	if h.finish != nil {
		return h.finish(op, result, err)
	}
	return result, err
}

func echo(ctx context.Context, args map[string]any) (string, error) {
	raw, _ := json.Marshal(args)
	return string(raw), nil
}

func sleepy(d time.Duration, result string) fakeTool {
	return func(ctx context.Context, _ map[string]any) (string, error) {
		select {
		case <-time.After(d):
			return result, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

var defaultLimits = Limits{Timeout: 5 * time.Second, MaxToolCalls: 32, MaxParallel: 4}

func run(t *testing.T, host *fakeHost, code string) Result {
	t.Helper()
	return Run(context.Background(), code, host, defaultLimits, nil)
}

func outcomes(r Result) string {
	parts := make([]string, 0, len(r.Ops))
	for _, op := range r.Ops {
		parts = append(parts, fmt.Sprintf("%d:%s:%s", op.Index, op.Tool, op.Outcome))
	}
	return strings.Join(parts, ",")
}

func TestRunCompletes(t *testing.T) {
	tests := []struct {
		name   string
		code   string
		output []string
	}{
		{name: "sequential calls", code: `const a = await tools.echo({n: 1}); const b = await tools.echo({prev: JSON.parse(a).n + 1}); text(b);`, output: []string{`{"prev":2}`}},
		{name: "return value", code: `return {ok: true, list: [1, "a"]}`, output: []string{`{"ok":true,"list":[1,"a"]}`}},
		{name: "return string", code: `return "plain"`, output: []string{"plain"}},
		{name: "undefined return adds nothing", code: `text("x"); return undefined`, output: []string{"x"}},
		{name: "console log", code: `console.log("a", 1, {b: 2})`, output: []string{`a 1 {"b":2}`}},
		{name: "hyphenated name", code: `return await tools["mcp_gh-work__issue"]({id: 3})`, output: []string{`{"id":3}`}},
		{name: "catch tool error", code: `try { await tools.fail({}) } catch (e) { return e.name + "/" + e.tool + "/" + e.message }`, output: []string{"ToolError/fail/boom"}},
		{name: "allSettled", code: `const r = await Promise.allSettled([tools.echo({}), tools.missing({})]); return r.map(x => x.status)`, output: []string{`["fulfilled","rejected"]`}},
		{name: "search and describe", code: `const s = await searchTools("issues", {server: "github", limit: 3}); const d = await describeTool("echo"); return [s, d]`, output: []string{`[{"query":"issues","server":"github","limit":3},{"name":"echo"}]`}},
		{name: "top-level await of nothing", code: `await null; return 1`, output: []string{"1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := &fakeHost{tools: map[string]fakeTool{
				"echo":               echo,
				"mcp_gh-work__issue": echo,
				"fail":               func(context.Context, map[string]any) (string, error) { return "", errors.New("boom") },
			}}
			r := run(t, host, tt.code)
			if r.Status != StatusCompleted {
				t.Fatalf("status = %s (%s)", r.Status, r.Error)
			}
			if strings.Join(r.Output, "\n") != strings.Join(tt.output, "\n") {
				t.Fatalf("output = %q, want %q", r.Output, tt.output)
			}
		})
	}
}

func TestRunFails(t *testing.T) {
	tests := []struct {
		name    string
		code    string
		status  Status
		wantErr string
	}{
		{name: "empty", code: "  ", status: StatusFailed, wantErr: "code is required"},
		{name: "too long", code: strings.Repeat("a", MaxSourceBytes+1), status: StatusFailed, wantErr: "longer than"},
		{name: "syntax error position", code: "const a = 1;\nconst x = ;", status: StatusFailed, wantErr: "(line 2, column 11)"},
		{name: "syntax error on first line", code: "const x = ;", status: StatusFailed, wantErr: "(line 1, column 11)"},
		{name: "markdown fence", code: "```js\nreturn 1\n```", status: StatusFailed, wantErr: "SyntaxError"},
		{name: "static import", code: "import fs from 'fs'", status: StatusFailed, wantErr: "SyntaxError"},
		{name: "runtime error line", code: "const a = 1;\nnull.x;", status: StatusFailed, wantErr: "(line 2)"},
		{name: "uncaught tool error", code: "await tools.fail({})", status: StatusFailed, wantErr: "ToolError: boom"},
		{name: "eval disabled", code: "return eval('1')", status: StatusFailed, wantErr: "EvalError"},
		{name: "Function disabled", code: "return Function('return 1')()", status: StatusFailed, wantErr: "EvalError"},
		{name: "dynamic import", code: "await import('fs')", status: StatusFailed, wantErr: "TypeError"},
		{name: "no require", code: "require('fs')", status: StatusFailed, wantErr: "ReferenceError"},
		{name: "no process", code: "process.exit(1)", status: StatusFailed, wantErr: "ReferenceError"},
		{name: "no timers", code: "setTimeout(() => {}, 1)", status: StatusFailed, wantErr: "ReferenceError"},
		{name: "frozen builtins", code: "'use strict'; Array.prototype.x = 1", status: StatusFailed, wantErr: "TypeError"},
		{name: "never settles", code: "await new Promise(() => {})", status: StatusFailed, wantErr: "nothing will settle"},
		{name: "unhandled rejection", code: "const p = tools.fail({}); await tools.echo({}); return 1", status: StatusFailed, wantErr: "unhandled promise rejection: ToolError: boom"},
		{name: "function argument", code: "await tools.echo({f: () => 1})", status: StatusFailed, wantErr: "cannot pass a function"},
		{name: "bigint argument", code: "await tools.echo({n: 1n})", status: StatusFailed, wantErr: "cannot pass a bigint"},
		{name: "non-finite argument", code: "await tools.echo({n: NaN})", status: StatusFailed, wantErr: "non-finite"},
		{name: "cyclic argument", code: "const a = {}; a.self = a; await tools.echo(a)", status: StatusFailed, wantErr: "contains itself"},
		{name: "array argument", code: "await tools.echo([1])", status: StatusFailed, wantErr: "must be an object"},
		{name: "deep argument", code: "let v = {}; for (let i = 0; i < 70; i++) v = {v}; await tools.echo(v)", status: StatusFailed, wantErr: "deeper than 64"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := &fakeHost{tools: map[string]fakeTool{
				"echo": echo,
				"fail": func(context.Context, map[string]any) (string, error) { return "", errors.New("boom") },
			}}
			r := run(t, host, tt.code)
			if r.Status != tt.status || !strings.Contains(r.Error, tt.wantErr) {
				t.Fatalf("result = %s %q, want %s containing %q", r.Status, r.Error, tt.status, tt.wantErr)
			}
		})
	}
}

func TestRunFreezesArguments(t *testing.T) {
	host := &fakeHost{tools: map[string]fakeTool{"echo": echo}}
	r := run(t, host, `const args = {v: 1}; const p = tools.echo(args); args.v = 2; return await p`)
	if r.Status != StatusCompleted || r.Output[0] != `{"v":1}` {
		t.Fatalf("result = %+v", r)
	}
}

func TestRunParallelSafeCallsOverlapUpToTheLimit(t *testing.T) {
	host := &fakeHost{
		tools: map[string]fakeTool{"read": sleepy(50*time.Millisecond, "r")},
		safe:  map[string]bool{"read": true},
	}
	r := run(t, host, `const r = await Promise.all([0,1,2,3,4,5].map(i => tools.read({i}))); return r.length`)
	if r.Status != StatusCompleted || r.Output[0] != "6" {
		t.Fatalf("result = %+v", r)
	}
	if peak := atomic.LoadInt32(&host.peak); peak != int32(defaultLimits.MaxParallel) {
		t.Fatalf("peak concurrency = %d, want %d", peak, defaultLimits.MaxParallel)
	}
}

func TestRunKeepsOrderOfUnsafeCalls(t *testing.T) {
	host := &fakeHost{
		tools: map[string]fakeTool{"write": sleepy(10*time.Millisecond, "w"), "read": sleepy(10*time.Millisecond, "r")},
		safe:  map[string]bool{"read": true},
	}
	r := run(t, host, `await Promise.all([tools.read({i: 0}), tools.write({i: 1}), tools.read({i: 2}), tools.read({i: 3})])`)
	if r.Status != StatusCompleted {
		t.Fatalf("result = %+v", r)
	}
	if peak := atomic.LoadInt32(&host.peak); peak != 2 {
		t.Fatalf("peak concurrency = %d, want 2 (the reads after the write)", peak)
	}
	order := make([]string, 0, len(host.calls))
	for _, op := range host.calls {
		order = append(order, fmt.Sprint(op.Args["i"]))
	}
	if order[0] != "0" || order[1] != "1" {
		t.Fatalf("start order = %v; the write must start after the first read and before later ones", order)
	}
}

func TestRunDecisions(t *testing.T) {
	host := &fakeHost{
		tools:     map[string]fakeTool{"echo": echo, "bash": echo, "denied": echo, "slow": sleepy(50*time.Millisecond, "done")},
		safe:      map[string]bool{"slow": true, "echo": true},
		decisions: map[string]Decision{"denied": {Kind: Reject, Message: "blocked by guard"}, "bash": {Kind: RequireApproval}},
	}

	r := run(t, host, `try { await tools.denied({}) } catch (e) { return e.message }`)
	if r.Status != StatusCompleted || r.Output[0] != "blocked by guard" || r.Ops[0].Outcome != OutcomeDenied {
		t.Fatalf("deny = %+v", r)
	}

	host.calls = nil
	r = run(t, host, `const s = tools.slow({}); await tools.echo({first: true}); try { await tools.bash({cmd: "ls"}) } catch (e) { text("caught") } await tools.echo({after: true})`)
	if r.Status != StatusRequiresDirectCall || r.Pending == nil || r.Pending.Tool != "bash" || r.Pending.Args["cmd"] != "ls" {
		t.Fatalf("handoff = %+v", r)
	}
	if len(r.Output) != 0 {
		t.Fatalf("the script kept running after the handoff: %q", r.Output)
	}
	if got := outcomes(r); got != "1:echo:succeeded,0:slow:succeeded,2:bash:requires_approval" {
		t.Fatalf("outcomes = %s", got)
	}
}

func TestRunCallBudget(t *testing.T) {
	host := &fakeHost{tools: map[string]fakeTool{"echo": echo}}
	r := Run(context.Background(), `const out = []; for (let i = 0; i < 3; i++) { try { await tools.echo({i}) ; out.push("ok") } catch (e) { out.push(e.message) } } return out`, host, Limits{Timeout: time.Second, MaxToolCalls: 2, MaxParallel: 1}, nil)
	if r.Status != StatusCompleted || !strings.Contains(r.Output[0], `"ok","ok","this script already made 2 tool operations`) {
		t.Fatalf("result = %+v", r)
	}
	if len(host.calls) != 2 {
		t.Fatalf("host calls = %d, want 2", len(host.calls))
	}
}

func TestRunEnding(t *testing.T) {
	t.Run("unawaited started call finishes", func(t *testing.T) {
		host := &fakeHost{tools: map[string]fakeTool{"slow": sleepy(50*time.Millisecond, "s"), "fast": echo}, safe: map[string]bool{"slow": true, "fast": true}}
		r := run(t, host, `tools.slow({}); await tools.fast({}); return 1`)
		if r.Status != StatusCompleted || outcomes(r) != "1:fast:succeeded,0:slow:succeeded" {
			t.Fatalf("result = %s %s", r.Status, outcomes(r))
		}
	})
	t.Run("unawaited queued call is dropped", func(t *testing.T) {
		host := &fakeHost{tools: map[string]fakeTool{"write": echo}}
		r := run(t, host, `tools.write({}); return 1`)
		if r.Status != StatusCompleted || outcomes(r) != "0:write:not_started" || len(host.calls) != 0 {
			t.Fatalf("result = %s %s calls %d", r.Status, outcomes(r), len(host.calls))
		}
	})
	t.Run("timeout interrupts a loop", func(t *testing.T) {
		host := &fakeHost{tools: map[string]fakeTool{}}
		start := time.Now()
		r := Run(context.Background(), `while (true) {}`, host, Limits{Timeout: 100 * time.Millisecond, MaxToolCalls: 1, MaxParallel: 1}, nil)
		if r.Status != StatusTimedOut || time.Since(start) > 2*time.Second {
			t.Fatalf("result = %+v after %v", r, time.Since(start))
		}
	})
	t.Run("timeout cancels a started call", func(t *testing.T) {
		host := &fakeHost{tools: map[string]fakeTool{"slow": sleepy(10*time.Second, "s")}}
		r := Run(context.Background(), `await tools.slow({})`, host, Limits{Timeout: 100 * time.Millisecond, MaxToolCalls: 1, MaxParallel: 1}, nil)
		if r.Status != StatusTimedOut || outcomes(r) != "0:slow:cancelled" {
			t.Fatalf("result = %s %s", r.Status, outcomes(r))
		}
		if len(host.finished) != 1 {
			t.Fatalf("host did not see the cancelled call finish: %v", host.finished)
		}
	})
	t.Run("task cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		host := &fakeHost{tools: map[string]fakeTool{"slow": sleepy(10*time.Second, "s")}}
		time.AfterFunc(50*time.Millisecond, cancel)
		r := Run(ctx, `await tools.slow({})`, host, defaultLimits, nil)
		if r.Status != StatusCancelled || outcomes(r) != "0:slow:cancelled" {
			t.Fatalf("result = %s %s", r.Status, outcomes(r))
		}
	})
	t.Run("output limit keeps earlier output and lets calls finish", func(t *testing.T) {
		host := &fakeHost{tools: map[string]fakeTool{"slow": sleepy(50*time.Millisecond, "s"), "fast": echo}, safe: map[string]bool{"slow": true, "fast": true}}
		r := run(t, host, `tools.slow({}); await tools.fast({}); for (let i = 0; ; i++) text("line " + i)`)
		if r.Status != StatusOutputLimit || len(r.Output) != MaxOutputItems || r.Output[0] != "line 0" {
			t.Fatalf("result = %s, %d items", r.Status, len(r.Output))
		}
		if outcomes(r) != "1:fast:succeeded,0:slow:succeeded" {
			t.Fatalf("outcomes = %s", outcomes(r))
		}
	})
	t.Run("output bytes limit", func(t *testing.T) {
		host := &fakeHost{}
		r := run(t, host, `const s = "x".repeat(40000); text(s); text(s); text("never")`)
		if r.Status != StatusOutputLimit || len(r.Output) != 1 {
			t.Fatalf("result = %s, %d items", r.Status, len(r.Output))
		}
	})
}

func TestRunResultLimits(t *testing.T) {
	big := strings.Repeat("x", MaxResultBytes+1)
	host := &fakeHost{tools: map[string]fakeTool{"big": func(context.Context, map[string]any) (string, error) { return big, nil }}}
	r := run(t, host, `try { await tools.big({}) } catch (e) { return e.message }`)
	if r.Status != StatusCompleted || !strings.Contains(r.Output[0], "the operation ran") || r.Ops[0].Outcome != OutcomeSucceeded {
		t.Fatalf("result = %+v", r)
	}
}

func TestRunFinishRedactsBeforeTheScriptSees(t *testing.T) {
	host := &fakeHost{
		tools: map[string]fakeTool{"secret": func(context.Context, map[string]any) (string, error) { return "token=abc", nil }},
		finish: func(_ Op, result string, err error) (string, error) {
			return strings.ReplaceAll(result, "abc", "[redacted]"), err
		},
	}
	r := run(t, host, `return await tools.secret({})`)
	if r.Output[0] != "token=[redacted]" {
		t.Fatalf("output = %q", r.Output)
	}
}

func TestRunConcurrentInvocations(t *testing.T) {
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			host := &fakeHost{tools: map[string]fakeTool{"echo": echo}, safe: map[string]bool{"echo": true}}
			r := Run(context.Background(), fmt.Sprintf(`globalThis.mark = %d; const r = await Promise.all([tools.echo({i: %d}), tools.echo({})]); return [globalThis.mark, r[0]]`, i, i), host, defaultLimits, nil)
			want := fmt.Sprintf(`[%d,"{\"i\":%d}"]`, i, i)
			if r.Status != StatusCompleted || r.Output[0] != want {
				t.Errorf("invocation %d = %s %q, want %s", i, r.Status, r.Output, want)
			}
		}(i)
	}
	wg.Wait()
}

func TestMemoryWatcherStopsInvocations(t *testing.T) {
	var heap atomic.Uint64
	heap.Store(100)
	watcher := &MemoryWatcher{
		interval: 5 * time.Millisecond,
		ceiling:  func() uint64 { return 1000 },
		read:     func() (uint64, uint64) { return heap.Load(), heap.Load() },
	}
	host := &fakeHost{tools: map[string]fakeTool{"slow": sleepy(10*time.Second, "s")}}
	time.AfterFunc(50*time.Millisecond, func() { heap.Store(5000) })
	r := Run(context.Background(), `await tools.slow({})`, host, defaultLimits, watcher)
	if r.Status != StatusMemoryLimit || outcomes(r) != "0:slow:cancelled" {
		t.Fatalf("result = %s %s", r.Status, outcomes(r))
	}
	if r.Memory.PeakHeapGrowthBytes != 4900 {
		t.Fatalf("memory = %+v", r.Memory)
	}
	watcher.mu.Lock()
	defer watcher.mu.Unlock()
	if len(watcher.watching) != 0 || watcher.stop != nil {
		t.Fatalf("watcher still running after the invocation")
	}
}

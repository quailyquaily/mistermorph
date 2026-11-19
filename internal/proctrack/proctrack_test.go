package proctrack

import (
	"context"
	"slices"
	"sort"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)

func at(sec int) time.Time { return t0.Add(time.Duration(sec) * time.Second) }

func pids(ms []member, keep func(member) bool) []int {
	var out []int
	for _, m := range ms {
		if keep == nil || keep(m) {
			out = append(out, m.proc.PID)
		}
	}
	sort.Ints(out)
	return out
}

func equal(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestMembers(t *testing.T) {
	roots := []Root{
		{PID: 100, Start: at(1), Kind: KindShell, Program: "bash", ActivityID: "a1"},
		{PID: 200, Start: at(-600), Kind: KindCoder, Program: "codex", ActivityID: "a2", CoderTag: "c1"},
	}
	procs := []Proc{
		{PID: 1, PPID: 0},
		{PID: 10, PPID: 1, Start: at(-1000), Name: "host"}, // self
		{PID: 100, PPID: 10, SID: 100, Start: at(1), Tags: map[string]string{EnvRun: "r1", EnvCall: "a1"}},
		{PID: 101, PPID: 100, SID: 100, Start: at(2), Tags: map[string]string{EnvRun: "r1", EnvCall: "a1"}},
		// Left behind by the shell call: re-parented, still tagged.
		{PID: 102, PPID: 1, SID: 102, Start: at(3), Tags: map[string]string{EnvRun: "r1", EnvCall: "a1"}},
		// Cleared its environment, kept the session.
		{PID: 103, PPID: 1, SID: 100, Start: at(4)},
		// Another run's.
		{PID: 104, PPID: 1, SID: 104, Start: at(4), Tags: map[string]string{EnvRun: "r2"}},
		// The coder server, its helper (started before the run) and a command it runs.
		{PID: 200, PPID: 10, SID: 200, Start: at(-600), Tags: map[string]string{EnvCoder: "c1"}},
		{PID: 201, PPID: 200, SID: 200, Start: at(-590), Tags: map[string]string{EnvCoder: "c1"}},
		// Left behind by the coder during the run.
		{PID: 202, PPID: 1, SID: 202, Start: at(5), Tags: map[string]string{EnvCoder: "c1"}},
		// Left behind by the coder before the run: an earlier run's.
		{PID: 203, PPID: 1, SID: 203, Start: at(-300), Tags: map[string]string{EnvCoder: "c1"}},
		// Unrelated.
		{PID: 300, PPID: 1, SID: 300, Start: at(2)},
	}
	ms := members("r1", at(0), time.Time{}, roots, procs, 10)
	if got, want := pids(ms, nil), []int{100, 101, 102, 103, 200, 201, 202}; !equal(got, want) {
		t.Fatalf("members = %v, want %v", got, want)
	}
	if got, want := pids(ms, func(m member) bool { return m.orphan }), []int{102, 103, 202}; !equal(got, want) {
		t.Fatalf("orphans = %v, want %v", got, want)
	}
	if got, want := pids(ms, func(m member) bool { return m.underServer }), []int{201}; !equal(got, want) {
		t.Fatalf("under the coder server = %v, want %v", got, want)
	}
	for _, m := range ms {
		if m.proc.PID == 102 && m.root != 0 {
			t.Fatalf("102 attributed to root %d, want 0", m.root)
		}
		if m.proc.PID == 202 && m.root != 1 {
			t.Fatalf("202 attributed to root %d, want 1", m.root)
		}
	}
}

type fakeSystem struct {
	mu      sync.Mutex
	procs   []Proc
	signals []int
	// ignoreTerm keeps processes alive on SIGTERM.
	ignoreTerm map[int]bool
}

func (f *fakeSystem) list() ([]Proc, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Proc(nil), f.procs...), nil
}

func (f *fakeSystem) signal(pid int, kill bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	sig := pid
	if kill {
		sig = -pid
	}
	f.signals = append(f.signals, sig)
	if !kill && f.ignoreTerm[pid] {
		return nil
	}
	for i, p := range f.procs {
		if p.PID == pid {
			f.procs = append(f.procs[:i], f.procs[i+1:]...)
			break
		}
	}
	return nil
}

func newFake(procs []Proc) (*Registry, *fakeSystem) {
	f := &fakeSystem{procs: procs, ignoreTerm: map[int]bool{}}
	g := NewRegistry(8)
	g.list, g.signal, g.grace = f.list, f.signal, 200*time.Millisecond
	g.now = func() time.Time { return at(10) }
	return g, f
}

func withSupport(t *testing.T) {
	old := Supported
	Supported = true
	t.Cleanup(func() { Supported = old })
}

func TestSweepStopsLeftoversOnly(t *testing.T) {
	withSupport(t)
	g, f := newFake([]Proc{
		{PID: 200, PPID: 1, Start: at(-600), Tags: map[string]string{EnvCoder: "c1"}},
		{PID: 201, PPID: 200, Start: at(-590), Tags: map[string]string{EnvCoder: "c1"}},
		{PID: 102, PPID: 1, SID: 102, Start: at(3), Tags: map[string]string{EnvRun: "r1", EnvCall: "a1"}},
		{PID: 110, PPID: 1, SID: 110, Start: at(3), Tags: map[string]string{EnvRun: "r1", EnvCall: "keep"}},
		{PID: 202, PPID: 1, SID: 202, Start: at(5), Tags: map[string]string{EnvCoder: "c1"}},
	})
	f.ignoreTerm[202] = true
	ctx, owner := g.Begin(context.Background())
	g.now = func() time.Time { return at(0) }
	Attach(ctx, "r1")
	if _, nested := g.Begin(ctx); nested != nil {
		t.Fatal("a nested run must not own the scope")
	}
	AddRoot(ctx, Root{PID: 100, Start: at(1), Kind: KindShell, ActivityID: "a1"})
	AddRoot(ctx, Root{PID: 109, Start: at(1), Kind: KindShell, ActivityID: "keep", Keep: true})
	AddRoot(ctx, Root{PID: 200, Start: at(-600), Kind: KindCoder, ActivityID: "a2", CoderTag: "c1"})

	owner.End(true) // paused: nothing happens
	if len(f.signals) != 0 {
		t.Fatalf("a paused run was swept: %v", f.signals)
	}
	g.now = func() time.Time { return at(10) }
	owner.End(false)
	left, _ := f.list()
	if got, want := pids(asMembers(left), nil), []int{110, 200, 201}; !equal(got, want) {
		t.Fatalf("left running = %v, want %v (signals %v)", got, want, f.signals)
	}
	// 202 ignored SIGTERM and got SIGKILL.
	if !slices.Contains(f.signals, -202) {
		t.Fatalf("202 was not killed: %v", f.signals)
	}
	tree, err := g.Tree("r1")
	if err != nil {
		t.Fatal(err)
	}
	if tree.Running || len(tree.Stopped) != 2 {
		t.Fatalf("tree = %+v", tree)
	}
}

func TestKillOnlyTheRunsProcesses(t *testing.T) {
	withSupport(t)
	g, f := newFake([]Proc{
		{PID: 102, PPID: 1, SID: 102, Start: at(3), Tags: map[string]string{EnvRun: "r1"}},
		{PID: 103, PPID: 102, SID: 102, Start: at(3), Tags: map[string]string{EnvRun: "r1"}},
		{PID: 300, PPID: 1, SID: 300, Start: at(3)},
	})
	g.now = func() time.Time { return at(0) }
	ctx, _ := g.Begin(context.Background())
	Attach(ctx, "r1")
	if _, err := g.Kill("r1", 102); err != ErrNotFound {
		t.Fatalf("a run that started nothing is not tracked: %v", err)
	}
	AddRoot(ctx, Root{PID: 100, Start: at(1), Kind: KindShell, ActivityID: "a1"})
	if _, err := g.Kill("r1", 300); err != ErrNotFound {
		t.Fatalf("kill of a stranger: %v", err)
	}
	stopped, err := g.Kill("r1", 102)
	if err != nil || len(stopped) != 2 {
		t.Fatalf("kill = %v, %v", stopped, err)
	}
	left, _ := f.list()
	if len(left) != 1 || left[0].PID != 300 {
		t.Fatalf("left = %v", left)
	}
}

func asMembers(procs []Proc) []member {
	out := make([]member, len(procs))
	for i, p := range procs {
		out[i] = member{proc: p}
	}
	return out
}

// A run that starts nothing leaves no record and is not swept.
func TestRunWithoutProcessesIsNotKept(t *testing.T) {
	withSupport(t)
	g, f := newFake([]Proc{{PID: 102, PPID: 1, Start: at(3), Tags: map[string]string{EnvRun: "quiet"}}})
	ctx, owner := g.Begin(context.Background())
	Attach(ctx, "quiet")
	owner.End(false)
	if len(f.signals) != 0 || g.run("quiet", false) != nil {
		t.Fatalf("signals %v, record %v", f.signals, g.run("quiet", false))
	}
}

func TestShellEnvReplacesTags(t *testing.T) {
	g := NewRegistry(4)
	ctx, _ := g.Begin(context.Background())
	if env := ShellEnv(ctx, []string{"A=1"}, "x"); len(env) != 1 {
		t.Fatalf("no run yet: %v", env)
	}
	Attach(ctx, "r9")
	env := ShellEnv(ctx, []string{"A=1", EnvRun + "=old", EnvCoder + "=c"}, "call")
	want := []string{"A=1", EnvRun + "=r9", EnvCall + "=call"}
	if len(env) != len(want) {
		t.Fatalf("env = %v", env)
	}
	for i := range want {
		if env[i] != want[i] {
			t.Fatalf("env = %v, want %v", env, want)
		}
	}
}

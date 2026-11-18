// Package proctrack finds the processes a run left behind and stops them.
//
// A run (one agent task: a Console reply, an awareness run) starts programs through the shell
// tools and the coding CLIs. Those programs can start others that outlive them: `loop.sh &`, a
// server, a watcher. When the program that started them exits, they are re-parented (to init or a
// subreaper), so their parent no longer says where they came from. The run marks what it starts
// instead, and finds the marks again later:
//
//   - The shell tools start each command in its own session (Setsid) with MISTERMORPH_RUN_ID and
//     MISTERMORPH_TOOL_CALL in its environment. Every descendant inherits both, also after it
//     starts a session of its own; one that clears its environment still keeps the session id,
//     unless it starts a new session too.
//   - A coding CLI's server outlives the run that started it: its next task reuses it. It runs with
//     MISTERMORPH_CODER_SESSION. What it starts and leaves behind (no longer under the live
//     server) during a run is that run's; what stays under the live server is the server's.
//
// When a run ends (not when it pauses for an approval), Sweep stops what it left running: SIGTERM,
// then SIGKILL for what is still there after a grace period. A shell call made with keep_running
// is left alone. Tree lists what a run has running, for the Console's process panel, and Kill stops
// one of them.
//
// Only the user's own processes are seen: another user's (a command run with sudo) can be neither
// read nor stopped. Windows has no sessions or readable environments; there the run tracks nothing
// yet (Supported is false).
package proctrack

import (
	"context"
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// EnvRun names the run a shell tool's command belongs to.
	EnvRun = "MISTERMORPH_RUN_ID"
	// EnvCall names the tool call (its activity id) within the run.
	EnvCall = "MISTERMORPH_TOOL_CALL"
	// EnvCoder names a coding CLI's server process (one per server start).
	EnvCoder = "MISTERMORPH_CODER_SESSION"
)

// Kinds of root.
const (
	KindShell = "shell"
	KindCoder = "coder"
)

// Proc is a process as a snapshot sees it.
type Proc struct {
	PID   int
	PPID  int
	SID   int
	Start time.Time
	Name  string
	Args  []string
	// Tags holds the MISTERMORPH_* variables of its environment (empty when unreadable).
	Tags map[string]string
}

func (p Proc) same(q Proc) bool { return p.PID == q.PID && p.Start.Equal(q.Start) }

// Root is a process a run started itself: a shell tool's shell, or a coding CLI's server.
type Root struct {
	PID        int
	Start      time.Time
	Kind       string
	Program    string
	ActivityID string
	// CoderTag is the coder server's EnvCoder value.
	CoderTag string
	// Keep is set for a shell call made with keep_running: what it leaves running stays.
	Keep bool
}

// Stopped records a process the sweep or the user stopped (or failed to).
type Stopped struct {
	Proc  Proc
	By    string // "sweep" or "user"
	At    time.Time
	Error string
}

// Run is one run's record.
type Run struct {
	mu      sync.Mutex
	id      string
	started time.Time
	ended   time.Time
	roots   []Root
	stopped []Stopped
}

func (r *Run) snapshot() (started, ended time.Time, roots []Root, stopped []Stopped) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.started, r.ended, append([]Root(nil), r.roots...), append([]Stopped(nil), r.stopped...)
}

// Registry keeps the recent runs of this process.
type Registry struct {
	mu    sync.Mutex
	runs  map[string]*Run
	order []string
	limit int
	// list and signal are replaced in tests.
	list   func() ([]Proc, error)
	signal func(pid int, kill bool) error
	grace  time.Duration
	now    func() time.Time
}

// NewRegistry returns an empty registry that keeps the last limit runs.
func NewRegistry(limit int) *Registry {
	if limit <= 0 {
		limit = 256
	}
	return &Registry{runs: map[string]*Run{}, limit: limit, list: Snapshot, signal: signalProcess, grace: 2 * time.Second, now: time.Now}
}

// Default is the registry of this process's runs.
var Default = NewRegistry(256)

func (g *Registry) run(id string, create bool) *Run {
	g.mu.Lock()
	defer g.mu.Unlock()
	if r := g.runs[id]; r != nil || !create {
		return r
	}
	r := &Run{id: id, started: g.now()}
	g.runs[id] = r
	g.order = append(g.order, id)
	for len(g.order) > g.limit {
		delete(g.runs, g.order[0])
		g.order = g.order[1:]
	}
	return r
}

// Scope is a run's handle in its context. The outermost run (Begin's owner) sweeps when it ends;
// the runs nested in it (a spawned subtask) share its scope.
type Scope struct {
	g  *Registry
	mu sync.Mutex
	id string
	// run is created when the run starts its first process: most runs (a reply without a
	// command, a title, a precheck) never do, and are neither kept nor swept.
	run *Run
}

type scopeKey struct{}

// Begin gives ctx a scope unless it has one. owner is nil for a nested run.
func (g *Registry) Begin(ctx context.Context) (_ context.Context, owner *Scope) {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Value(scopeKey{}).(*Scope); ok {
		return ctx, nil
	}
	s := &Scope{g: g}
	return context.WithValue(ctx, scopeKey{}, s), s
}

// Attach names the scope's run once its id is known (a resumed run learns it from its saved
// state). A scope keeps the first id it is given: a nested run's id does not replace its task's.
func Attach(ctx context.Context, runID string) {
	s := scopeOf(ctx)
	runID = strings.TrimSpace(runID)
	if s == nil || runID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.id != "" {
		return
	}
	s.id = runID
	// A resumed run goes on in its record, if this process still has it.
	if r := s.g.run(runID, false); r != nil {
		r.mu.Lock()
		r.ended = time.Time{}
		r.mu.Unlock()
		s.run = r
	}
}

func scopeOf(ctx context.Context) *Scope {
	if ctx == nil {
		return nil
	}
	s, _ := ctx.Value(scopeKey{}).(*Scope)
	return s
}

func (s *Scope) current() *Run {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.run
}

// record is the scope's run record, created on first use ("" id: none).
func (s *Scope) record() *Run {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.run == nil && s.id != "" {
		s.run = s.g.run(s.id, true)
	}
	return s.run
}

// RunID is the id of ctx's run ("" outside a run).
func RunID(ctx context.Context) string {
	s := scopeOf(ctx)
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.id
}

// ShellEnv adds the run's tags to env for a shell tool's command (env unchanged outside a run).
func ShellEnv(ctx context.Context, env []string, activityID string) []string {
	id := RunID(ctx)
	if id == "" {
		return env
	}
	env = WithoutTags(env)
	env = append(env, EnvRun+"="+id)
	if activityID != "" {
		env = append(env, EnvCall+"="+activityID)
	}
	return env
}

// WithoutTags drops the MISTERMORPH_* tags from env (a process started from a tagged shell
// carries its run's; a coder server must not).
func WithoutTags(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, EnvRun+"=") || strings.HasPrefix(kv, EnvCall+"=") || strings.HasPrefix(kv, EnvCoder+"=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// AddRoot records a process ctx's run started. A coder server's root is recorded on every task
// it runs; its tag is read from the process once.
func AddRoot(ctx context.Context, root Root) {
	if root.PID <= 0 || !Supported {
		return
	}
	r := scopeOf(ctx).record()
	if r == nil {
		return
	}
	if root.Start.IsZero() || (root.Kind == KindCoder && root.CoderTag == "") {
		if p, err := readProc(root.PID); err == nil {
			if root.Start.IsZero() {
				root.Start = p.Start
			}
			if root.CoderTag == "" {
				root.CoderTag = p.Tags[EnvCoder]
			}
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, existing := range r.roots {
		if existing.PID == root.PID && existing.Start.Equal(root.Start) {
			r.roots[i] = root
			return
		}
	}
	r.roots = append(r.roots, root)
}

// End closes the owner's run: a paused run (waiting for an approval) keeps going later, so only a
// finished one is swept.
func (s *Scope) End(paused bool) {
	r := s.current()
	if r == nil || paused {
		return
	}
	r.mu.Lock()
	r.ended = s.g.now()
	none := len(r.roots) == 0
	r.mu.Unlock()
	if none {
		return
	}
	if Supported {
		_ = s.g.sweep(r)
	}
}

// Supported tells whether processes can be tracked on this system.
var Supported = supported

// ErrNotFound is returned for a run or process the registry does not know.
var ErrNotFound = errors.New("not found")

// member is a process attributed to a run.
type member struct {
	proc Proc
	// root is the index of the root it belongs to (-1: none known).
	root int
	// isRoot marks the root process itself.
	isRoot bool
	// underServer marks a coder server's live descendant: the server's, not left behind.
	underServer bool
	orphan      bool
}

// members finds the run's processes in procs. self and its ancestors are never members.
func members(id string, started, ended time.Time, roots []Root, procs []Proc, self int) []member {
	byPID := make(map[int]Proc, len(procs))
	for _, p := range procs {
		byPID[p.PID] = p
	}
	protected := map[int]bool{}
	for pid := self; pid > 1; {
		if protected[pid] {
			break
		}
		protected[pid] = true
		p, ok := byPID[pid]
		if !ok {
			break
		}
		pid = p.PPID
	}
	// Live roots, by pid.
	live := map[int]int{}
	for i, root := range roots {
		if p, ok := byPID[root.PID]; ok && p.Start.Equal(root.Start) {
			live[root.PID] = i
		}
	}
	// The live root a process descends from, if any (walking its parents).
	underRoot := func(p Proc) (int, bool) {
		seen := map[int]bool{}
		for pid := p.PPID; pid > 1 && !seen[pid]; {
			seen[pid] = true
			if i, ok := live[pid]; ok {
				return i, true
			}
			q, ok := byPID[pid]
			if !ok {
				return 0, false
			}
			pid = q.PPID
		}
		return 0, false
	}
	byActivity := map[string]int{}
	byCoderTag := map[string]int{}
	shellBySID := map[int]int{}
	for i, root := range roots {
		if root.ActivityID != "" {
			if _, ok := byActivity[root.ActivityID]; !ok {
				byActivity[root.ActivityID] = i
			}
		}
		if root.Kind == KindCoder && root.CoderTag != "" {
			byCoderTag[root.CoderTag] = i
		}
		if root.Kind == KindShell {
			shellBySID[root.PID] = i
		}
	}
	inWindow := func(p Proc) bool {
		if p.Start.Before(started.Add(-time.Second)) {
			return false
		}
		return ended.IsZero() || !p.Start.After(ended)
	}

	var out []member
	for _, p := range procs {
		if protected[p.PID] {
			continue
		}
		if i, ok := live[p.PID]; ok {
			out = append(out, member{proc: p, root: i, isRoot: true})
			continue
		}
		tagged := p.Tags[EnvRun]
		if tagged != "" && tagged != id {
			continue // another run's
		}
		i, under := underRoot(p)
		if under {
			out = append(out, member{proc: p, root: i, underServer: roots[i].Kind == KindCoder})
			continue
		}
		if tagged == id {
			root := -1
			if j, ok := byActivity[p.Tags[EnvCall]]; ok {
				root = j
			} else if j, ok := shellBySID[p.SID]; ok {
				root = j
			}
			out = append(out, member{proc: p, root: root, orphan: true})
			continue
		}
		if tagged != "" {
			continue
		}
		// Untagged: a shell command's that cleared its environment (same session), or what a
		// coder server left behind during this run.
		if j, ok := shellBySID[p.SID]; ok && !p.Start.Before(roots[j].Start) {
			out = append(out, member{proc: p, root: j, orphan: true})
			continue
		}
		if j, ok := byCoderTag[p.Tags[EnvCoder]]; ok && p.Tags[EnvCoder] != "" && inWindow(p) {
			out = append(out, member{proc: p, root: j, orphan: true})
		}
	}
	return out
}

func (g *Registry) sweep(r *Run) error {
	procs, err := g.list()
	if err != nil {
		return err
	}
	started, ended, roots, _ := r.snapshot()
	var targets []Proc
	for _, m := range members(r.id, started, ended, roots, procs, os.Getpid()) {
		if m.underServer || (m.isRoot && roots[m.root].Kind == KindCoder) {
			continue
		}
		if m.root >= 0 && roots[m.root].Keep {
			continue
		}
		targets = append(targets, m.proc)
	}
	g.stop(r, targets, "sweep")
	return nil
}

// stop sends SIGTERM to procs, waits up to the grace period, then SIGKILLs what is left. A
// process is signaled only while it is still the one the snapshot saw (same pid and start time).
func (g *Registry) stop(r *Run, procs []Proc, by string) []Stopped {
	if len(procs) == 0 {
		return nil
	}
	errs := map[int]error{}
	for _, p := range procs {
		if err := g.signal(p.PID, false); err != nil && !errors.Is(err, os.ErrProcessDone) {
			errs[p.PID] = err
		}
	}
	alive := func() []Proc {
		now, err := g.list()
		if err != nil {
			return nil
		}
		byPID := map[int]Proc{}
		for _, p := range now {
			byPID[p.PID] = p
		}
		var left []Proc
		for _, p := range procs {
			if q, ok := byPID[p.PID]; ok && q.same(p) && errs[p.PID] == nil {
				left = append(left, p)
			}
		}
		return left
	}
	deadline := time.Now().Add(g.grace)
	left := alive()
	for len(left) > 0 && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		left = alive()
	}
	for _, p := range left {
		if err := g.signal(p.PID, true); err != nil && !errors.Is(err, os.ErrProcessDone) {
			errs[p.PID] = err
		}
	}
	at := g.now()
	out := make([]Stopped, 0, len(procs))
	for _, p := range procs {
		s := Stopped{Proc: p, By: by, At: at}
		if err := errs[p.PID]; err != nil {
			s.Error = err.Error()
		}
		out = append(out, s)
	}
	r.mu.Lock()
	r.stopped = append(r.stopped, out...)
	if n := len(r.stopped); n > 200 {
		r.stopped = append([]Stopped(nil), r.stopped[n-200:]...)
	}
	r.mu.Unlock()
	return out
}

// Node is a process in a run's tree.
type Node struct {
	PID      int       `json:"pid"`
	PPID     int       `json:"ppid"`
	Name     string    `json:"name"`
	Command  string    `json:"command,omitempty"`
	Started  time.Time `json:"started_at"`
	Orphan   bool      `json:"orphan,omitempty"`
	Children []*Node   `json:"children,omitempty"`
}

// Group is a root and what runs under it or was left behind by it.
type Group struct {
	Kind       string    `json:"kind"`
	Program    string    `json:"program"`
	ActivityID string    `json:"activity_id,omitempty"`
	PID        int       `json:"pid"`
	Started    time.Time `json:"started_at"`
	Running    bool      `json:"running"`
	Keep       bool      `json:"keep,omitempty"`
	Processes  []*Node   `json:"processes,omitempty"`
}

// StoppedProc is a stopped process as the tree lists it.
type StoppedProc struct {
	PID     int       `json:"pid"`
	Name    string    `json:"name"`
	Command string    `json:"command,omitempty"`
	By      string    `json:"by"`
	At      time.Time `json:"at"`
	Error   string    `json:"error,omitempty"`
}

// Tree is a run's processes.
type Tree struct {
	Supported bool          `json:"supported"`
	Known     bool          `json:"known"`
	Running   bool          `json:"running"`
	Groups    []Group       `json:"groups"`
	Other     []*Node       `json:"other,omitempty"`
	Stopped   []StoppedProc `json:"stopped,omitempty"`
}

func command(p Proc) string {
	cmd := strings.Join(p.Args, " ")
	if len(cmd) > 400 {
		cmd = cmd[:400] + "…"
	}
	return cmd
}

// Tree lists what the run has running now and what was stopped. A run this process does not
// know (it ran before a restart) gives an empty tree with Known false.
func (g *Registry) Tree(runID string) (Tree, error) {
	tree := Tree{Supported: Supported, Groups: []Group{}}
	r := g.run(strings.TrimSpace(runID), false)
	if r == nil || !Supported {
		return tree, nil
	}
	tree.Known = true
	procs, err := g.list()
	if err != nil {
		return tree, err
	}
	started, ended, roots, stopped := r.snapshot()
	tree.Running = ended.IsZero()
	ms := members(r.id, started, ended, roots, procs, os.Getpid())

	nodes := map[int]*Node{}
	for _, m := range ms {
		nodes[m.proc.PID] = &Node{PID: m.proc.PID, PPID: m.proc.PPID, Name: m.proc.Name, Command: command(m.proc), Started: m.proc.Start, Orphan: m.orphan}
	}
	groups := make([]Group, len(roots))
	for i, root := range roots {
		groups[i] = Group{Kind: root.Kind, Program: root.Program, ActivityID: root.ActivityID, PID: root.PID, Started: root.Start, Keep: root.Keep}
	}
	sort.SliceStable(ms, func(a, b int) bool { return ms[a].proc.Start.Before(ms[b].proc.Start) })
	for _, m := range ms {
		n := nodes[m.proc.PID]
		if m.isRoot {
			groups[m.root].Running = true
			groups[m.root].Processes = append(groups[m.root].Processes, n)
			continue
		}
		if parent, ok := nodes[m.proc.PPID]; ok {
			parent.Children = append(parent.Children, n)
			continue
		}
		if m.root >= 0 {
			groups[m.root].Processes = append(groups[m.root].Processes, n)
		} else {
			tree.Other = append(tree.Other, n)
		}
	}
	// A coder server's long-lived helpers are shown under it; a finished shell with nothing left
	// is not shown at all.
	for _, group := range groups {
		if group.Running || len(group.Processes) > 0 {
			tree.Groups = append(tree.Groups, group)
		}
	}
	for _, s := range stopped {
		tree.Stopped = append(tree.Stopped, StoppedProc{PID: s.Proc.PID, Name: s.Proc.Name, Command: command(s.Proc), By: s.By, At: s.At, Error: s.Error})
	}
	return tree, nil
}

// Kill stops pid and its descendants, if pid is one of the run's processes.
func (g *Registry) Kill(runID string, pid int) ([]Stopped, error) {
	r := g.run(strings.TrimSpace(runID), false)
	if r == nil || !Supported {
		return nil, ErrNotFound
	}
	procs, err := g.list()
	if err != nil {
		return nil, err
	}
	started, ended, roots, _ := r.snapshot()
	ms := members(r.id, started, ended, roots, procs, os.Getpid())
	isMember := map[int]Proc{}
	for _, m := range ms {
		isMember[m.proc.PID] = m.proc
	}
	target, ok := isMember[pid]
	if !ok {
		return nil, ErrNotFound
	}
	children := map[int][]Proc{}
	for _, p := range procs {
		children[p.PPID] = append(children[p.PPID], p)
	}
	self := os.Getpid()
	var list []Proc
	var walk func(p Proc)
	walk = func(p Proc) {
		if p.PID == self {
			return
		}
		list = append(list, p)
		for _, c := range children[p.PID] {
			walk(c)
		}
	}
	walk(target)
	return g.stop(r, list, "user"), nil
}

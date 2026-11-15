// Package codersessions owns the coding CLIs' sessions: one process per session, talking JSON
// lines over stdin and stdout (`codex app-server`, `agy acp`, `claude -p` with JSON streams).
// It reads no screen: only what the CLIs report over an interface made for a host program, and
// Codex's rollout files for its usage.
package codersessions

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

type key struct{ scope, backend string }
type session struct {
	rpc            *rpc
	id, cwd, model string
	bypass, busy   bool
	cancel         context.CancelFunc
	finished       chan struct{}
	// Codex's usage reader survives a server restart and counts only new responses.
	usage         *CodexUsageReader
	protocolUsage bool
	tokenTotal    int64
	// Claude Code: whether the session is on disk (reopened with --resume).
	resumable bool
}
type Sessions struct {
	mu     sync.Mutex
	items  map[key]*session
	closed bool
}

func (m *Sessions) Run(ctx context.Context, scope string, req Request) (output string, err error) {
	if req.Backend != "codex" && req.Backend != "agy" && req.Backend != "claude" {
		return "", fmt.Errorf("unsupported coder: %s", req.Backend)
	}
	if scope == "" {
		return "", fmt.Errorf("coder session requires a scope")
	}
	k := key{scope, req.Backend}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return "", fmt.Errorf("coder runtime is closed")
	}
	if m.items == nil {
		m.items = map[key]*session{}
	}
	s := m.items[k]
	if s != nil && s.busy {
		m.mu.Unlock()
		return "", fmt.Errorf("coder is already handling a task in this scope")
	}
	if s != nil && s.cwd != req.CWD {
		if s.rpc != nil {
			s.rpc.close()
		}
		delete(m.items, k)
		s = nil
	}
	if s == nil {
		s = &session{cwd: req.CWD, bypass: req.BypassApprovals}
		m.items[k] = s
	}
	if s.rpc != nil && (s.rpc.exited() || s.bypass != req.BypassApprovals) {
		s.rpc.close()
		s.rpc = nil
	}
	s.bypass = req.BypassApprovals
	ctx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.finished = make(chan struct{})
	s.busy = true
	m.mu.Unlock()
	started := time.Now()
	run := coderusage.Run{Backend: req.Backend}
	var quota *coderusage.Quota
	defer func() {
		if (err != nil || ctx.Err() != nil) && s.rpc != nil {
			s.rpc.close()
		}
		if req.Report != nil {
			run.DurationMs = time.Since(started).Milliseconds()
			req.Report(run, quota)
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		cancel()
		close(s.finished)
		s.busy = false
		if err != nil {
			s.rpc = nil
		}
	}()
	switch req.Backend {
	case "codex":
		output, run, quota, err = s.codex(ctx, req)
	case "claude":
		output, run, quota, err = s.claude(ctx, req)
	default:
		output, run, err = s.agy(ctx, req)
	}
	return
}
func (m *Sessions) Reset(scope string) {
	m.stop(scope, false)
}
func (m *Sessions) Close() {
	m.stop("", true)
}
func (m *Sessions) stop(scope string, all bool) {
	m.mu.Lock()
	if all {
		m.closed = true
	}
	var wait []chan struct{}
	for k, s := range m.items {
		if all || k.scope == scope {
			if s.busy {
				s.cancel()
				wait = append(wait, s.finished)
			} else if s.rpc != nil {
				s.rpc.close()
			}
			delete(m.items, k)
		}
	}
	m.mu.Unlock()
	for _, done := range wait {
		<-done
	}
}
func ask(ctx context.Context, req Request, q Question) (Answer, error) {
	if !req.CanAsk || req.Ask == nil {
		text := q.Text
		if len(q.Options) > 0 && !q.ChoicesOnly {
			text += " (options: " + strings.Join(q.Options, "; ") + ")"
		}
		return Answer{}, fmt.Errorf("coder needs a user answer: %s", text)
	}
	return req.Ask(ctx, q)
}
func note(req Request, text string) {
	if req.Note != nil && text != "" {
		req.Note(text)
	}
}
func progress(req Request, text string) {
	if req.Progress != nil {
		req.Progress(text)
	}
}

// Package coderterm runs a coding CLI (Claude Code or Codex) in a persistent terminal.
// It reads only the terminal screen and the CLI's own session file.
package coderterm

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode"
)

const noTextReply = "The coding CLI finished this turn without a text reply."

type Question struct {
	Text        string
	Options     []string
	ChoicesOnly bool
}

type Answer struct {
	Option int // Negative for a text answer.
	Text   string
}

type Request struct {
	Backend  string // "claude" or "codex".
	Command  string
	Env      []string
	CWD      string
	Task     string
	LogRoot  string
	Ask      func(context.Context, Question) (Answer, error)
	Progress func(string)
}

// Sessions belongs to one runtime. Its zero value is ready to use.
type Sessions struct {
	mu    sync.Mutex
	items map[sessionKey]*session
	// resume holds conversations whose terminal failed; the next task reopens them.
	resume map[sessionKey]resumePoint
	closed bool
}

// sessionKey separates each CLI's session within one conversation.
type sessionKey struct{ scope, backend string }

type resumePoint struct{ id, cwd string }

func (m *Sessions) Run(ctx context.Context, scope string, req Request) (string, error) {
	b, err := backendFor(req.Backend)
	if err != nil {
		return "", err
	}
	name := b.label()
	if scope == "" {
		return "", fmt.Errorf("%s terminal requires a conversation", name)
	}
	if err := checkText(req.Task); err != nil {
		return "", err
	}
	key := sessionKey{scope, strings.ToLower(strings.TrimSpace(req.Backend))}
	// The CLIs record a pasted CR as LF; match that so the transcript check holds.
	req.Task = strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(req.Task)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return "", fmt.Errorf("%s runtime is closed", name)
	}
	s := m.items[key]
	if s != nil && s.busy {
		m.mu.Unlock()
		return "", fmt.Errorf("%s is already handling a task in this conversation", name)
	}
	if s != nil && (s.cwd != req.CWD || s.exited()) {
		if s.cwd == req.CWD {
			// The process ended between tasks; reopen its conversation.
			m.remember(key, s, nil)
		}
		s.close()
		delete(m.items, key)
		s = nil
	}
	if s == nil {
		var resumeID string
		if point, ok := m.resume[key]; ok && point.cwd == req.CWD {
			resumeID = point.id
		}
		// A changed cwd starts fresh; a failed reopen is remembered again only if it gets far enough.
		delete(m.resume, key)
		s, err = start(b, req, resumeID)
		if err != nil {
			m.mu.Unlock()
			return "", err
		}
		if m.items == nil {
			m.items = make(map[sessionKey]*session)
		}
		m.items[key] = s
	}
	s.busy = true
	m.mu.Unlock()

	output, err := s.run(ctx, req)
	m.mu.Lock()
	s.busy = false
	if err != nil {
		s.close()
		// A Reset or Close during the run already removed it and wants a fresh start.
		if m.items[key] == s {
			delete(m.items, key)
			m.remember(key, s, err)
		}
	}
	m.mu.Unlock()
	return output, err
}

// remember keeps a failed conversation for --resume. Caller holds m.mu.
func (m *Sessions) remember(key sessionKey, s *session, err error) {
	// Without a submitted task there is nothing to reopen, unless this was a reopen
	// the caller stopped early. Any other early failure means resume itself is broken.
	stopped := errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
	if s.id == "" || (!s.prompted && !(s.resumed && stopped)) {
		return
	}
	if m.resume == nil {
		m.resume = make(map[sessionKey]resumePoint)
	}
	m.resume[key] = resumePoint{id: s.id, cwd: s.cwd}
}

// Reset releases a conversation's terminals when it is reset or deleted. The next task starts fresh.
func (m *Sessions) Reset(scope string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key := range m.resume {
		if key.scope == scope {
			delete(m.resume, key)
		}
	}
	for key, s := range m.items {
		if key.scope == scope {
			s.close()
			delete(m.items, key)
		}
	}
}

func (m *Sessions) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	m.resume = nil
	for key, s := range m.items {
		s.close()
		delete(m.items, key)
	}
}

func checkText(text string) error {
	for _, r := range text {
		if unicode.IsControl(r) && r != '\n' && r != '\t' && r != '\r' {
			return fmt.Errorf("terminal text contains a control character")
		}
	}
	return nil
}

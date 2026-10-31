// Package claudeterm runs Claude Code in a persistent, screen-reader terminal.
package claudeterm

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode"
)

const noTextReply = "Claude finished this turn without a text reply."

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
	items map[string]*session
	// resume holds conversations whose terminal failed; the next task reopens them.
	resume map[string]resumePoint
	closed bool
}

type resumePoint struct{ id, cwd string }

func (m *Sessions) Run(ctx context.Context, scope string, req Request) (string, error) {
	if scope == "" {
		return "", fmt.Errorf("Claude terminal requires a conversation")
	}
	if err := checkText(req.Task); err != nil {
		return "", err
	}
	// Claude records a pasted CR as LF; match that so the transcript check holds.
	req.Task = strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(req.Task)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return "", fmt.Errorf("Claude runtime is closed")
	}
	s := m.items[scope]
	if s != nil && s.busy {
		m.mu.Unlock()
		return "", fmt.Errorf("Claude is already handling a task in this conversation")
	}
	if s != nil && (s.cwd != req.CWD || s.exited()) {
		if s.cwd == req.CWD {
			// The process ended between tasks; reopen its conversation.
			m.remember(scope, s, nil)
		}
		s.close()
		delete(m.items, scope)
		s = nil
	}
	if s == nil {
		var resumeID string
		if point, ok := m.resume[scope]; ok && point.cwd == req.CWD {
			resumeID = point.id
		}
		// A changed cwd starts fresh; a failed reopen is remembered again only if it gets far enough.
		delete(m.resume, scope)
		var err error
		s, err = start(req, resumeID)
		if err != nil {
			m.mu.Unlock()
			return "", err
		}
		if m.items == nil {
			m.items = make(map[string]*session)
		}
		m.items[scope] = s
	}
	s.busy = true
	m.mu.Unlock()

	output, err := s.run(ctx, req)
	m.mu.Lock()
	s.busy = false
	if err != nil {
		s.close()
		// A Reset or Close during the run already removed it and wants a fresh start.
		if m.items[scope] == s {
			delete(m.items, scope)
			m.remember(scope, s, err)
		}
	}
	m.mu.Unlock()
	return output, err
}

// remember keeps a failed conversation for --resume. Caller holds m.mu.
func (m *Sessions) remember(scope string, s *session, err error) {
	// Without a submitted task there is nothing to reopen, unless this was a reopen
	// the caller stopped early. Any other early failure means resume itself is broken.
	stopped := errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
	if !s.prompted && !(s.resumed && stopped) {
		return
	}
	if m.resume == nil {
		m.resume = make(map[string]resumePoint)
	}
	m.resume[scope] = resumePoint{id: s.id, cwd: s.cwd}
}

// Reset releases the terminal when a conversation is reset or deleted. The next task starts fresh.
func (m *Sessions) Reset(scope string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.resume, scope)
	if s := m.items[scope]; s != nil {
		s.close()
		delete(m.items, scope)
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

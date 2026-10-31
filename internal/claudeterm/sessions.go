// Package claudeterm runs Claude Code in a persistent, screen-reader terminal.
package claudeterm

import (
	"context"
	"fmt"
	"sync"
	"unicode"
)

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
	mu     sync.Mutex
	items  map[string]*session
	closed bool
}

func (m *Sessions) Run(ctx context.Context, scope string, req Request) (string, error) {
	if scope == "" {
		return "", fmt.Errorf("Claude terminal requires a conversation")
	}
	if err := checkText(req.Task); err != nil {
		return "", err
	}
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
		s.close()
		delete(m.items, scope)
		s = nil
	}
	if s == nil {
		var err error
		s, err = start(req)
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
		if m.items[scope] == s {
			delete(m.items, scope)
		}
	}
	m.mu.Unlock()
	return output, err
}

// Reset releases the terminal when a conversation is reset or deleted.
func (m *Sessions) Reset(scope string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.items[scope]; s != nil {
		s.close()
		delete(m.items, scope)
	}
}

func (m *Sessions) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
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

package runtimecontrol

import (
	"context"
	"errors"
	"strings"
)

var (
	ErrNoActiveRun         = errors.New("no active run")
	ErrQuestionAlreadyOpen = errors.New("a question is already open")
	ErrQuestionMissingID   = errors.New("question id is required")
)

// Answer is the user's answer to an open question: the choice at Option, or typed Text when Option
// is negative. A choice's Text is its label.
type Answer struct {
	Text   string
	Option int
}

// Typed reports whether the user typed the answer rather than choosing an option.
func (a Answer) Typed() bool {
	return a.Option < 0
}

type openQuestion struct {
	choicesOnly bool
	id          string
	options     []string
	answer      chan Answer
}

// OpenQuestion is a question open on a run: the next message steered into the run, or a Choose or
// AnswerText call naming its ID, answers it.
type OpenQuestion struct {
	control  *RunControl
	entry    *activeRun
	question *openQuestion
}

// OpenQuestion opens question id, with the labels of its choices, on the lease's run. Open it
// before showing it, so no answer comes too early; Close it when done waiting.
func (l *RunLease) OpenQuestion(id string, options []string, choicesOnly bool) (*OpenQuestion, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, ErrQuestionMissingID
	}
	if l == nil || l.control == nil {
		return nil, ErrNoActiveRun
	}
	c := l.control
	key, err := keyFrom(l.runtime, l.conversationKey)
	if err != nil {
		return nil, err
	}
	question := &openQuestion{id: id, options: append([]string(nil), options...), choicesOnly: choicesOnly, answer: make(chan Answer, 1)}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.active[key]
	if entry == nil || strings.TrimSpace(entry.TaskID) != l.taskID || entry.stopRequested {
		return nil, ErrNoActiveRun
	}
	if entry.question != nil {
		return nil, ErrQuestionAlreadyOpen
	}
	entry.question = question
	return &OpenQuestion{control: c, entry: entry, question: question}, nil
}

// Wait waits for the answer, and returns ctx's error when ctx ends first.
func (q *OpenQuestion) Wait(ctx context.Context) (Answer, error) {
	select {
	case answer := <-q.question.answer:
		return answer, nil
	case <-ctx.Done():
		return Answer{}, ctx.Err()
	}
}

// Close closes the question if it is still open; later answers to it do nothing.
func (q *OpenQuestion) Close() {
	q.control.mu.Lock()
	defer q.control.mu.Unlock()
	if q.entry.question == q.question {
		q.entry.question = nil
	}
}

// AwaitAnswer opens question id on the lease's run and waits for its answer, until ctx ends.
func (l *RunLease) AwaitAnswer(ctx context.Context, id string, options []string) (Answer, error) {
	question, err := l.OpenQuestion(id, options, false)
	if err != nil {
		return Answer{}, err
	}
	defer question.Close()
	return question.Wait(ctx)
}

// Choose answers open question id, on an active run of runtime, with its choice at option: a
// button press. It returns the choice's label, and false when the question is not open (answered,
// expired, or another runtime's) or has no such choice, so a stale button does nothing.
func (c *RunControl) Choose(runtime string, id string, option int) (string, bool) {
	runtime = strings.TrimSpace(runtime)
	id = strings.TrimSpace(id)
	if c == nil || runtime == "" || id == "" {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, entry := range c.active {
		if key.runtime != runtime || entry == nil || entry.question == nil || entry.question.id != id {
			continue
		}
		if option < 0 || option >= len(entry.question.options) {
			return "", false
		}
		label := entry.question.options[option]
		answerLocked(entry, Answer{Text: label, Option: option})
		return label, true
	}
	return "", false
}

// AnswerText answers open question id, on an active run of runtime, with typed text. It reports
// whether the question was open.
func (c *RunControl) AnswerText(runtime string, id string, text string) bool {
	runtime = strings.TrimSpace(runtime)
	id = strings.TrimSpace(id)
	text = strings.TrimSpace(text)
	if c == nil || runtime == "" || id == "" || text == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, entry := range c.active {
		if key.runtime == runtime && entry != nil && entry.question != nil && entry.question.id == id && !entry.question.choicesOnly {
			answerLocked(entry, Answer{Text: text, Option: -1})
			return true
		}
	}
	return false
}

// answerLocked gives answer to entry's open question and closes it. c.mu is held.
func answerLocked(entry *activeRun, answer Answer) {
	entry.question.answer <- answer
	entry.question = nil
}

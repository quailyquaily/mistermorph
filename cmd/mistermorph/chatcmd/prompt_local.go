package chatcmd

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

// errQuestionDismissed is what ask_user gets when the person closed the card without answering.
var errQuestionDismissed = errors.New("the user closed the question without answering")

// localPrompter puts a local turn's questions and elevated-command approvals to the person in the
// TUI: it opens a card through send and waits for the answer, or for ctx to end.
type localPrompter struct {
	send func(any)
	seq  atomic.Uint64
}

func newLocalPrompter(send func(any)) *localPrompter {
	return &localPrompter{send: send}
}

// withLocalPrompts gives a local turn's run the ask_user tool and the approver for elevated
// commands. ask_user is registered when the engine is prepared, so ctx must carry it then.
func withLocalPrompts(ctx context.Context, prompter *localPrompter) context.Context {
	if prompter == nil || prompter.send == nil {
		return ctx
	}
	ctx = elevate.WithApprover(ctx, elevate.ApproverFunc(prompter.approve))
	return taskruntime.WithUserQuestions(ctx, prompter.ask)
}

func (l *localPrompter) nextKey() string {
	return fmt.Sprintf("local:%d", l.seq.Add(1))
}

// localRespond hands the answer to the waiting ask and closes the card.
func localRespond(reply chan<- chatPromptResponse) func(*chatModel, *chatPrompt, chatPromptResponse) tea.Cmd {
	return func(m *chatModel, p *chatPrompt, resp chatPromptResponse) tea.Cmd {
		outcome := localOutcome(p, resp)
		select {
		case reply <- resp:
		default:
			// The ask already ended; the answer goes nowhere.
			clear(resp.password)
		}
		return m.closePrompt(p.key, outcome)
	}
}

func localOutcome(p *chatPrompt, resp chatPromptResponse) string {
	switch {
	case p.kind == chatPromptElevation && resp.decline:
		return promptOutcome(p, "declined")
	case p.kind == chatPromptElevation:
		return promptOutcome(p, "password sent")
	case resp.decline:
		return promptOutcome(p, "dismissed without an answer")
	}
	return promptOutcome(p, "Answer: "+resp.text)
}

// approve is the elevate.Approver of a local turn.
func (l *localPrompter) approve(ctx context.Context, req elevate.Request) (string, error) {
	reply := make(chan chatPromptResponse, 1)
	p := newElevationPrompt(l.nextKey(), req.Command, req.Dir, "", req.Deadline, req.Attempt)
	p.respond = localRespond(reply)
	l.send(promptOpenMsg{prompt: p})
	select {
	case resp := <-reply:
		if resp.decline {
			return "", elevate.ErrDeclined
		}
		password := string(resp.password)
		clear(resp.password)
		return password, nil
	case <-ctx.Done():
		l.send(promptExpiredMsg{key: p.key})
		select {
		case resp := <-reply:
			clear(resp.password)
		default:
		}
		return "", elevate.ErrTimedOut
	}
}

// ask is the taskruntime.AskUserFunc of a local turn.
func (l *localPrompter) ask(ctx context.Context, q taskruntime.UserQuestion) (runtimecontrol.Answer, error) {
	reply := make(chan chatPromptResponse, 1)
	deadline, _ := ctx.Deadline()
	p := newQuestionPrompt(l.nextKey(), q, deadline)
	p.respond = localRespond(reply)
	l.send(promptOpenMsg{prompt: p})
	select {
	case resp := <-reply:
		if resp.decline {
			return runtimecontrol.Answer{}, errQuestionDismissed
		}
		return runtimecontrol.Answer{Text: resp.text, Option: resp.option}, nil
	case <-ctx.Done():
		l.send(promptExpiredMsg{key: p.key})
		return runtimecontrol.Answer{}, ctx.Err()
	}
}

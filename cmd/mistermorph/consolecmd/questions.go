package consolecmd

import (
	"context"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

// consoleChatTriggerRef marks a task sent from the Console chat, and consoleCLIChatTriggerRef one
// sent from chat attached to this runtime (--runtime-url): the places where a person watches the
// task and can answer its questions and approval cards.
const (
	consoleChatTriggerRef    = "web/console/chat"
	consoleCLIChatTriggerRef = "cli/chat"
)

const (
	consoleQuestionOpen     = "open"
	consoleQuestionAnswered = "answered"
	consoleQuestionExpired  = "expired"
)

// consoleQuestion is a question a task asked (ask_user), as the chat shows it.
type consoleQuestion struct {
	ChoicesOnly bool                             `json:"choices_only,omitempty"`
	ID          string                           `json:"id"`
	Text        string                           `json:"text"`
	Options     []taskruntime.UserQuestionOption `json:"options,omitempty"`
	Status      string                           `json:"status"`
	Answer      string                           `json:"answer,omitempty"`
	// Option is the index of the chosen option, or -1 for a typed answer; set when answered.
	Option *int `json:"option,omitempty"`
}

func cloneConsoleQuestions(in []consoleQuestion) []consoleQuestion {
	if len(in) == 0 {
		return nil
	}
	out := make([]consoleQuestion, len(in))
	for i, q := range in {
		out[i] = q
		out[i].Options = append([]taskruntime.UserQuestionOption(nil), q.Options...)
		if q.Option != nil {
			option := *q.Option
			out[i].Option = &option
		}
	}
	return out
}

// consoleAsksUser reports whether a task may ask its person: questions (ask_user) and approval
// cards for elevated commands. That is one sent from the Console chat or from chat.
func consoleAsksUser(trigger daemonruntime.TaskTrigger) bool {
	if strings.TrimSpace(trigger.Source) != "ui" {
		return false
	}
	switch strings.TrimSpace(trigger.Ref) {
	case consoleChatTriggerRef, consoleCLIChatTriggerRef:
		return true
	}
	return false
}

// consoleTaskQuestions keeps a task's questions and publishes each change to the chat.
type consoleTaskQuestions struct {
	mu        sync.Mutex
	taskID    string
	hub       *consoleStreamHub
	questions []consoleQuestion
}

func (q *consoleTaskQuestions) snapshot() []consoleQuestion {
	q.mu.Lock()
	defer q.mu.Unlock()
	return cloneConsoleQuestions(q.questions)
}

func (q *consoleTaskQuestions) publish() {
	if q.hub != nil {
		q.hub.PublishQuestions(q.taskID, q.snapshot())
	}
}

// show is the task's taskruntime.ShowUserQuestionFunc: the chat shows the question as a card, and
// settling it records the answer on the card.
func (q *consoleTaskQuestions) show(_ context.Context, question taskruntime.UserQuestion) (func(context.Context, *runtimecontrol.Answer), error) {
	q.mu.Lock()
	index := len(q.questions)
	q.questions = append(q.questions, consoleQuestion{
		ChoicesOnly: question.ChoicesOnly,
		ID:          question.ID,
		Text:        question.Text,
		Options:     append([]taskruntime.UserQuestionOption(nil), question.Options...),
		Status:      consoleQuestionOpen,
	})
	q.mu.Unlock()
	q.publish()
	return func(_ context.Context, answer *runtimecontrol.Answer) {
		q.mu.Lock()
		settled := &q.questions[index]
		if answer == nil {
			settled.Status = consoleQuestionExpired
		} else {
			option := answer.Option
			if answer.Typed() {
				option = -1
			}
			settled.Status = consoleQuestionAnswered
			settled.Answer = answer.Text
			settled.Option = &option
		}
		q.mu.Unlock()
		q.publish()
	}, nil
}

// answerQuestion answers the open question of a running Console task, with typed text or one of
// its choices.
func (r *consoleLocalRuntime) answerQuestion(_ context.Context, req daemonruntime.AnswerQuestionRequest) (daemonruntime.AnswerQuestionResponse, error) {
	if strings.TrimSpace(req.TaskID) == "" || strings.TrimSpace(req.QuestionID) == "" {
		return daemonruntime.AnswerQuestionResponse{}, daemonruntime.BadRequest("task_id and question_id are required")
	}
	if r == nil || r.runControl == nil {
		return daemonruntime.AnswerQuestionResponse{}, nil
	}
	if text := strings.TrimSpace(req.Text); text != "" {
		ok := r.runControl.AnswerText("console", req.QuestionID, text)
		return daemonruntime.AnswerQuestionResponse{Answered: ok, Answer: text}, nil
	}
	label, ok := r.runControl.Choose("console", req.QuestionID, req.Option)
	return daemonruntime.AnswerQuestionResponse{Answered: ok, Answer: label}, nil
}

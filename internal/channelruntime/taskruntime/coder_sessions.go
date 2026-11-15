package taskruntime

import (
	"context"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/codersessions"
)

// CoderSessionRunner binds a run's scope and interaction policy to its runtime's sessions.
// A question channel alone never enables approvals: only the Console sets canAsk.
func CoderSessionRunner(sessions *codersessions.Sessions, scope string, canAsk bool, ask AskUserFunc) func(context.Context, agent.CoderRequest) (string, error) {
	return func(ctx context.Context, request agent.CoderRequest) (string, error) {
		req := codersessions.Request{Backend: request.Backend, Command: request.Command, Env: request.Env, CWD: request.CWD, Task: request.Task,
			BypassApprovals: !canAsk || request.BypassApprovals, CanAsk: canAsk, Process: request.Process, Report: request.Report,
			Progress: func(status string) {
				if request.Progress != nil {
					request.Progress(status, status+"\n", status)
				}
			},
			Note: func(text string) {
				if request.Progress != nil {
					request.Progress("", text+"\n", "")
				}
			},
		}
		if canAsk && ask != nil {
			req.Ask = func(ctx context.Context, q codersessions.Question) (codersessions.Answer, error) {
				question := UserQuestion{ID: newUserQuestionID(), Text: q.Text, ChoicesOnly: q.ChoicesOnly}
				for _, option := range q.Options {
					question.Options = append(question.Options, UserQuestionOption{Label: option})
				}
				a, err := ask(ctx, question)
				return codersessions.Answer{Option: a.Option, Text: a.Text}, err
			}
		}
		return sessions.Run(ctx, scope, req)
	}
}

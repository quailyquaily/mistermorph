package codersessions

import (
	"context"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

// Request is one protocol task and its runtime-owned callbacks.
type Request struct {
	Backend, Command, CWD, Task string
	Env                         []string
	BypassApprovals, CanAsk     bool
	Ask                         func(context.Context, Question) (Answer, error)
	Progress                    func(string)
	Note                        func(string)
	Process                     func(int)
	Report                      func(coderusage.Run, *coderusage.Quota)
}

// Question is what a coder asks the user: an approval, or a question of its own.
type Question struct {
	Text        string
	Options     []string
	ChoicesOnly bool
}

// Answer is the user's reply to a Question.
type Answer struct {
	Option int // Negative for a text answer.
	Text   string
}

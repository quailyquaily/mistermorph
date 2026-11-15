package codersessions

import (
	"context"

	"github.com/quailyquaily/mistermorph/internal/coderterm"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

// Request is one protocol task and its runtime-owned callbacks.
type Request struct {
	Backend, Command, CWD, Task, LogRoot string
	Env                                  []string
	BypassApprovals, CanAsk              bool
	Ask                                  func(context.Context, coderterm.Question) (coderterm.Answer, error)
	Progress                             func(string)
	Note                                 func(string)
	Process                              func(int)
	Report                               func(coderusage.Run, *coderusage.Quota)
}

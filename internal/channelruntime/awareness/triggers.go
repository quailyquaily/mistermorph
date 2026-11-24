package awareness

import (
	"context"

	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// Triggers start awareness runs from outside the loop: Poke wakes the agent, and CronRun starts a
// job now (a person's run, a job poke or a message trigger).
type Triggers struct {
	Poke daemonruntime.PokeFunc
	// CronRun is nil when the loop runs no jobs (RunOptions.CronEnabled is off).
	CronRun daemonruntime.CronRunFunc
}

// AttachTriggers gives opts the request channels its loop reads and returns the functions that
// feed them. The functions block until the loop takes the request or ctx ends, so a caller that
// may outlive the loop must bound their contexts by the loop's.
func AttachTriggers(opts *RunOptions) Triggers {
	if opts == nil {
		return Triggers{}
	}
	pokeRequests := make(chan PokeRequest)
	opts.PokeRequests = pokeRequests
	triggers := Triggers{
		Poke: func(ctx context.Context, input awarenessdomain.PokeInput) error {
			return Trigger(ctx, pokeRequests, input)
		},
	}
	if opts.CronEnabled {
		cronRequests := make(chan CronRequest)
		opts.CronRequests = cronRequests
		triggers.CronRun = func(ctx context.Context, run cronstore.RunRequest) (string, error) {
			return StartCronRun(ctx, cronRequests, run)
		}
	}
	return triggers
}

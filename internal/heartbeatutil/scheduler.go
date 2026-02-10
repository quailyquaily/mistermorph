package heartbeatutil

import "strings"

type TickOutcome int

const (
	TickEnqueued TickOutcome = iota
	TickSkipped
	TickBuildError
)

type TaskBuilder func() (task string, checklistEmpty bool, err error)

type TaskEnqueuer func(task string, checklistEmpty bool) (skipReason string)

type TickResult struct {
	Outcome      TickOutcome
	SkipReason   string
	BuildError   error
	AlertMessage string
}

func Tick(state *State, buildTask TaskBuilder, enqueueTask TaskEnqueuer) TickResult {
	if state == nil || buildTask == nil || enqueueTask == nil {
		return TickResult{
			Outcome:    TickSkipped,
			SkipReason: "invalid_config",
		}
	}
	if !state.Start() {
		return TickResult{
			Outcome:    TickSkipped,
			SkipReason: "already_running",
		}
	}

	task, checklistEmpty, err := buildTask()
	if err != nil {
		alert, msg := state.EndFailure(err)
		result := TickResult{
			Outcome:    TickBuildError,
			BuildError: err,
		}
		if alert {
			result.AlertMessage = strings.TrimSpace(msg)
		}
		return result
	}
	if strings.TrimSpace(task) == "" {
		state.EndSkipped()
		return TickResult{
			Outcome:    TickSkipped,
			SkipReason: "empty_task",
		}
	}

	reason := strings.TrimSpace(enqueueTask(task, checklistEmpty))
	if reason != "" {
		state.EndSkipped()
		return TickResult{
			Outcome:    TickSkipped,
			SkipReason: reason,
		}
	}

	return TickResult{Outcome: TickEnqueued}
}

package agent

import "strings"

const (
	PlanStatusPending    = "pending"
	PlanStatusInProgress = "in_progress"
	PlanStatusCompleted  = "completed"
)

func NormalizePlanSteps(p *Plan) {
	if p == nil {
		return
	}
	for i := range p.Steps {
		p.Steps[i].Step = strings.TrimSpace(p.Steps[i].Step)
		st := strings.ToLower(strings.TrimSpace(p.Steps[i].Status))
		switch st {
		case PlanStatusPending, PlanStatusInProgress, PlanStatusCompleted:
			p.Steps[i].Status = st
		default:
			p.Steps[i].Status = PlanStatusPending
		}
	}

	// Ensure exactly one in_progress step if there are incomplete steps.
	inProgress := -1
	firstPending := -1
	for i := range p.Steps {
		switch p.Steps[i].Status {
		case PlanStatusInProgress:
			if inProgress == -1 {
				inProgress = i
			} else {
				// multiple in_progress -> demote extras
				p.Steps[i].Status = PlanStatusPending
			}
		case PlanStatusPending:
			if firstPending == -1 {
				firstPending = i
			}
		}
	}
	if inProgress == -1 && firstPending != -1 {
		p.Steps[firstPending].Status = PlanStatusInProgress
	}
}

func AdvancePlanOnSuccess(p *Plan) (completedIndex int, completedStep string, startedIndex int, startedStep string, ok bool) {
	if p == nil || len(p.Steps) == 0 {
		return -1, "", -1, "", false
	}
	NormalizePlanSteps(p)

	cur := -1
	next := -1
	for i := range p.Steps {
		if p.Steps[i].Status == PlanStatusInProgress && cur == -1 {
			cur = i
			continue
		}
		if next == -1 && p.Steps[i].Status == PlanStatusPending {
			next = i
		}
	}

	if cur != -1 {
		completedIndex = cur
		completedStep = p.Steps[cur].Step
		p.Steps[cur].Status = PlanStatusCompleted
	}
	if next != -1 {
		startedIndex = next
		startedStep = p.Steps[next].Step
		p.Steps[next].Status = PlanStatusInProgress
	}
	return completedIndex, completedStep, startedIndex, startedStep, completedIndex != -1
}

func CompleteAllPlanSteps(p *Plan) {
	if p == nil {
		return
	}
	NormalizePlanSteps(p)
	for i := range p.Steps {
		p.Steps[i].Status = PlanStatusCompleted
	}
}

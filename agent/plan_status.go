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

	normalized := make(PlanSteps, 0, len(p.Steps))
	for i := range p.Steps {
		step := strings.TrimSpace(p.Steps[i].Step)
		if step == "" {
			continue
		}
		st := strings.ToLower(strings.TrimSpace(p.Steps[i].Status))
		if st != PlanStatusPending && st != PlanStatusInProgress && st != PlanStatusCompleted {
			st = PlanStatusPending
		}
		normalized = append(normalized, PlanStep{
			Step:      step,
			Status:    st,
			Note:      strings.TrimSpace(p.Steps[i].Note),
			ToolCalls: p.Steps[i].ToolCalls,
		})
	}
	p.Steps = normalized
	if len(p.Steps) == 0 {
		return
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

// RecordPlanStepToolCall counts a tool call against the step in progress.
func RecordPlanStepToolCall(p *Plan) {
	if p == nil {
		return
	}
	for i := range p.Steps {
		if p.Steps[i].Status == PlanStatusInProgress {
			p.Steps[i].ToolCalls++
			return
		}
	}
}

// CompletePlanStep closes the step in progress with the agent's note and starts the next pending
// step. It does nothing while the step has made no tool call: text sent with a step's first tool
// calls announces its work rather than reporting it.
func CompletePlanStep(p *Plan, note string) (completedIndex int, completedStep string, startedIndex int, startedStep string, ok bool) {
	completedIndex, startedIndex = -1, -1
	if p == nil {
		return completedIndex, "", startedIndex, "", false
	}
	cur, next := -1, -1
	for i := range p.Steps {
		if cur == -1 && p.Steps[i].Status == PlanStatusInProgress {
			cur = i
			continue
		}
		if next == -1 && p.Steps[i].Status == PlanStatusPending {
			next = i
		}
	}
	if cur == -1 || p.Steps[cur].ToolCalls == 0 {
		return completedIndex, "", startedIndex, "", false
	}
	completedIndex, completedStep = cur, p.Steps[cur].Step
	p.Steps[cur].Status = PlanStatusCompleted
	p.Steps[cur].Note = strings.TrimSpace(note)
	if next != -1 {
		startedIndex, startedStep = next, p.Steps[next].Step
		p.Steps[next].Status = PlanStatusInProgress
	}
	return completedIndex, completedStep, startedIndex, startedStep, true
}

func CurrentPlanStep(p *Plan) (index int, step string, ok bool) {
	if p == nil || len(p.Steps) == 0 {
		return -1, "", false
	}

	for i := range p.Steps {
		if p.Steps[i].Status == PlanStatusInProgress {
			return i, p.Steps[i].Step, true
		}
	}
	for i := range p.Steps {
		if p.Steps[i].Status == PlanStatusPending {
			return i, p.Steps[i].Step, true
		}
	}
	return -1, "", false
}

func CompleteAllPlanSteps(p *Plan) {
	if p == nil {
		return
	}
	for i := range p.Steps {
		p.Steps[i].Status = PlanStatusCompleted
	}
}

// PlanNotes are the notes of the completed steps, in order: what the agent told the user as it
// finished each step.
func PlanNotes(p *Plan) []string {
	if p == nil {
		return nil
	}
	var notes []string
	for _, step := range p.Steps {
		if note := strings.TrimSpace(step.Note); note != "" && step.Status == PlanStatusCompleted {
			notes = append(notes, note)
		}
	}
	return notes
}

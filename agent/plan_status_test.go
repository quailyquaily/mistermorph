package agent

import "testing"

func TestNormalizePlanStepsDropsEmptySteps(t *testing.T) {
	plan := &Plan{
		Steps: PlanSteps{
			{Step: "   ", Status: PlanStatusPending},
			{Step: " collect data ", Status: ""},
			{Step: "", Status: PlanStatusInProgress},
			{Step: "summarize", Status: "unknown"},
		},
	}

	NormalizePlanSteps(plan)

	if len(plan.Steps) != 2 {
		t.Fatalf("len(plan.Steps) = %d, want 2", len(plan.Steps))
	}
	if plan.Steps[0].Step != "collect data" {
		t.Fatalf("steps[0].step = %q, want %q", plan.Steps[0].Step, "collect data")
	}
	if plan.Steps[0].Status != PlanStatusInProgress {
		t.Fatalf("steps[0].status = %q, want %q", plan.Steps[0].Status, PlanStatusInProgress)
	}
	if plan.Steps[1].Step != "summarize" {
		t.Fatalf("steps[1].step = %q, want %q", plan.Steps[1].Step, "summarize")
	}
	if plan.Steps[1].Status != PlanStatusPending {
		t.Fatalf("steps[1].status = %q, want %q", plan.Steps[1].Status, PlanStatusPending)
	}
}

func TestCompletePlanStepWaitsForTheStepsFirstToolCall(t *testing.T) {
	plan := &Plan{Steps: PlanSteps{
		{Step: "collect data", Status: PlanStatusInProgress},
		{Step: "summarize", Status: PlanStatusPending},
	}}
	if _, _, _, _, ok := CompletePlanStep(plan, "I'll collect the data."); ok {
		t.Fatal("a step with no tool call closed")
	}
	RecordPlanStepToolCall(plan)
	completedIndex, completedStep, startedIndex, startedStep, ok := CompletePlanStep(plan, "  Found 12 rows.  ")
	if !ok || completedIndex != 0 || completedStep != "collect data" || startedIndex != 1 || startedStep != "summarize" {
		t.Fatalf("CompletePlanStep = (%d, %q, %d, %q, %v)", completedIndex, completedStep, startedIndex, startedStep, ok)
	}
	if plan.Steps[0].Status != PlanStatusCompleted || plan.Steps[0].Note != "Found 12 rows." {
		t.Fatalf("steps[0] = %+v", plan.Steps[0])
	}
	// The next step has made no call yet, so text does not close it.
	if _, _, _, _, ok := CompletePlanStep(plan, "Summarizing now."); ok || plan.Steps[1].Status != PlanStatusInProgress {
		t.Fatalf("steps[1] = %+v, closed without a tool call", plan.Steps[1])
	}
}

func TestCompletePlanStepWithNoStepInProgress(t *testing.T) {
	plan := &Plan{Steps: PlanSteps{{Step: "done", Status: PlanStatusCompleted, ToolCalls: 2}}}
	completedIndex, completedStep, startedIndex, startedStep, ok := CompletePlanStep(plan, "note")
	if ok || completedIndex != -1 || completedStep != "" || startedIndex != -1 || startedStep != "" {
		t.Fatalf("CompletePlanStep = (%d, %q, %d, %q, %v)", completedIndex, completedStep, startedIndex, startedStep, ok)
	}
	if _, _, _, _, ok := CompletePlanStep(nil, "note"); ok {
		t.Fatal("nil plan closed a step")
	}
}

func TestNormalizePlanStepsKeepsNotesAndCounts(t *testing.T) {
	plan := &Plan{Steps: PlanSteps{{Step: "read", Status: PlanStatusCompleted, Note: " 6 sections ", ToolCalls: 1}}}
	NormalizePlanSteps(plan)
	if plan.Steps[0].Note != "6 sections" || plan.Steps[0].ToolCalls != 1 {
		t.Fatalf("steps[0] = %+v", plan.Steps[0])
	}
}

// Models that answer in the response format sometimes wrap the step's message in it, as in a
// console task where gpt-5.6-sol sent a plan response with each step's tool calls.
func TestPlanStepNoteFromText(t *testing.T) {
	cases := []struct {
		name, text, want string
	}{
		{"plain text", "  官网可正常访问，主体为 ARCH株式会社。 ", "官网可正常访问，主体为 ARCH株式会社。"},
		{"plan response", `{"type":"plan","reasoning":"官网可正常访问，主体为 ARCH株式会社。","steps":[{"step":"查看官网","status":"completed"},{"step":"查询登记","status":"in_progress"}]}`, "官网可正常访问，主体为 ARCH株式会社。"},
		{"fenced final response", "```json\n{\"type\":\"final\",\"output\":\"Read 6 sections.\"}\n```", "Read 6 sections."},
		{"plan response without reasoning", `{"type":"plan","steps":[{"step":"a","status":"completed"}]}`, ""},
		{"other JSON", `{"status":"ok"}`, ""},
		{"text that only starts with a brace", "{draft} is saved as draft.md.", "{draft} is saved as draft.md."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := planStepNoteFromText(tc.text); got != tc.want {
				t.Fatalf("planStepNoteFromText(%q) = %q, want %q", tc.text, got, tc.want)
			}
		})
	}
}

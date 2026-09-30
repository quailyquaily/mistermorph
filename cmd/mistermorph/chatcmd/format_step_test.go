package chatcmd

import (
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

func TestChatHistoryKeepsStepMessagesBeforeTheReply(t *testing.T) {
	final := &agent.Final{
		Output: "review_zh.html is ready.",
		Plan: &agent.Plan{Steps: []agent.PlanStep{
			{Step: "read", Status: agent.PlanStatusCompleted, Note: "6 sections."},
			{Step: "write", Status: agent.PlanStatusCompleted},
		}},
	}
	if got, want := formatRawChatHistoryOutput(final), "6 sections.\n\nreview_zh.html is ready."; got != want {
		t.Fatalf("history output = %q, want %q", got, want)
	}
	if got := formatRawChatHistoryOutput(&agent.Final{Output: "hi"}); got != "hi" {
		t.Fatalf("without a plan = %q", got)
	}
}

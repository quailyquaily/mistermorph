package chathistory

import (
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestBuildTaskHistoryIncludesPlanStepMessagesBeforeTheReply(t *testing.T) {
	created := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	finished := created.Add(time.Minute)
	// A console task result as stored: the plan's steps with the agent's notes, then the final answer.
	task := taskdomain.TaskInfo{
		ID: "t1", TopicID: "topic", Task: "make the slides", Status: taskdomain.TaskDone,
		CreatedAt: created, FinishedAt: &finished,
		Result: map[string]any{
			"final": map[string]any{"output": "review_zh.html is ready."},
			"plan": map[string]any{"steps": []any{
				map[string]any{"step": "read", "status": "completed", "note": "6 sections, 2 tables."},
				map[string]any{"step": "write", "status": "completed", "note": "Wrote 7 slides."},
				map[string]any{"step": "check", "status": "completed"},
			}},
		},
	}
	next := taskdomain.TaskInfo{ID: "t2", CreatedAt: finished.Add(time.Minute)}
	history := BuildTaskHistory([]taskdomain.TaskInfo{task}, next, 10)
	var texts []string
	for _, item := range history {
		texts = append(texts, item.Kind+": "+item.Text)
	}
	want := []string{
		KindInboundUser + ": make the slides",
		KindOutboundAgent + ": 6 sections, 2 tables.",
		KindOutboundAgent + ": Wrote 7 slides.",
		KindOutboundAgent + ": review_zh.html is ready.",
	}
	if len(texts) != len(want) {
		t.Fatalf("history = %q, want %q", texts, want)
	}
	for i := range want {
		if texts[i] != want[i] {
			t.Fatalf("history = %q, want %q", texts, want)
		}
	}
}

func TestTaskStepMessagesWithoutAPlan(t *testing.T) {
	if got := TaskStepMessages(taskdomain.TaskInfo{ID: "t", Result: map[string]any{"final": map[string]any{"output": "hi"}}}); len(got) != 0 {
		t.Fatalf("step messages = %+v", got)
	}
}

package agent

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

func insightResponse(text, tool string) llm.Result {
	r := toolCallResponse(tool)
	r.Text = text
	return r
}

func runForInsights(t *testing.T, ctx context.Context, client llm.Client, opts ...Option) ([]string, *Context) {
	t.Helper()
	reg := baseRegistry()
	for _, name := range []string{"read_file", "write_file", "check"} {
		reg.Register(&mockTool{name: name, result: "ok"})
	}
	var sent []string
	ctx = WithEventSinkContext(ctx, EventSinkFunc(func(_ context.Context, event Event) {
		if event.Kind == EventKindInsight {
			sent = append(sent, event.Text)
		}
	}))
	e := New(client, reg, Config{MaxSteps: 10}, DefaultPromptSpec(), opts...)
	_, runCtx, err := e.Run(ctx, "test", RunOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	return sent, runCtx
}

func TestInsights(t *testing.T) {
	t.Run("text after the first tool call is sent", func(t *testing.T) {
		client := newMockClient(
			insightResponse("I'll read the file first.", "read_file"),
			insightResponse("The config sets the timeout to 0, which disables it.", "write_file"),
			toolCallResponse("check"),
			finalResponse("done"),
		)
		sent, runCtx := runForInsights(t, context.Background(), client, WithInsights(3))
		want := []string{"The config sets the timeout to 0, which disables it."}
		if fmt.Sprint(sent) != fmt.Sprint(want) || fmt.Sprint(runCtx.Insights) != fmt.Sprint(want) {
			t.Fatalf("sent = %q, recorded = %q, want %q", sent, runCtx.Insights, want)
		}
	})

	t.Run("past the limit text is not sent", func(t *testing.T) {
		client := newMockClient(
			toolCallResponse("read_file"),
			insightResponse("first", "write_file"),
			insightResponse("second", "check"),
			insightResponse("third", "check"),
			finalResponse("done"),
		)
		sent, runCtx := runForInsights(t, context.Background(), client, WithInsights(2))
		if want := []string{"first", "second"}; fmt.Sprint(sent) != fmt.Sprint(want) || len(runCtx.Insights) != 2 {
			t.Fatalf("sent = %q, recorded = %q, want %q", sent, runCtx.Insights, want)
		}
	})

	t.Run("disabled without the option", func(t *testing.T) {
		client := newMockClient(
			toolCallResponse("read_file"),
			insightResponse("a finding", "write_file"),
			finalResponse("done"),
		)
		sent, runCtx := runForInsights(t, context.Background(), client)
		if len(sent) != 0 || len(runCtx.Insights) != 0 {
			t.Fatalf("sent = %q, recorded = %q, want none", sent, runCtx.Insights)
		}
	})

	t.Run("a plan takes the text as step notes", func(t *testing.T) {
		client := newMockClient(
			llm.Result{Text: `{"type":"plan","steps":[{"step":"read"},{"step":"write"}]}`},
			toolCallResponse("read_file"),
			insightResponse("The file has 6 sections.", "write_file"),
			finalResponse("done"),
		)
		var notes []string
		sent, _ := runForInsights(t, context.Background(), client, WithInsights(3),
			WithPlanStepUpdate(func(_ *Context, update PlanStepUpdate) {
				if update.CompletedNote != "" {
					notes = append(notes, update.CompletedNote)
				}
			}))
		if len(sent) != 0 || len(notes) != 1 {
			t.Fatalf("sent = %q, notes = %q, want only the step note", sent, notes)
		}
	})

	t.Run("subtasks do not send", func(t *testing.T) {
		client := newMockClient(
			toolCallResponse("read_file"),
			insightResponse("a finding", "write_file"),
			finalResponse("done"),
		)
		sent, _ := runForInsights(t, WithSubtaskDepth(context.Background(), 1), client, WithInsights(3))
		if len(sent) != 0 {
			t.Fatalf("sent = %q, want none", sent)
		}
	})
}

func TestInsightsSurviveRunStateSnapshot(t *testing.T) {
	c := NewContext("task", 5)
	c.Insights = []string{"a finding"}
	restored := contextFromSnapshot(snapshotFromContext(c))
	if fmt.Sprint(restored.Insights) != fmt.Sprint(c.Insights) {
		t.Fatalf("restored insights = %q, want %q", restored.Insights, c.Insights)
	}
}

func reminderCalls(calls []llm.Request) []int {
	var out []int
	for i, call := range calls {
		for _, message := range call.Messages {
			if message.Role == "user" && strings.Contains(message.Content, "[[ Runtime Note ]]") {
				out = append(out, i)
				break
			}
		}
	}
	return out
}

func TestInsightReminder(t *testing.T) {
	silentSteps := func(n int) []llm.Result {
		tools := []string{"read_file", "write_file", "check"}
		var out []llm.Result
		for i := 0; i < n; i++ {
			out = append(out, toolCallResponse(tools[i%len(tools)]))
		}
		return out
	}

	t.Run("once, after five silent responses", func(t *testing.T) {
		client := newMockClient(append(silentSteps(8), finalResponse("done"))...)
		runForInsights(t, context.Background(), client, WithInsights(3))
		// Calls 0-4 are the five silent responses; the note is first sent with call 5 and stays.
		if got := reminderCalls(client.allCalls()); len(got) == 0 || got[0] != insightReminderAfter {
			t.Fatalf("reminder in calls %v, want from call %d", got, insightReminderAfter)
		}
		reminders := 0
		for _, message := range client.allCalls()[len(client.allCalls())-1].Messages {
			if strings.Contains(message.Content, "[[ Runtime Note ]]") {
				reminders++
			}
		}
		if reminders != 1 {
			t.Fatalf("reminders in the last request = %d, want 1", reminders)
		}
	})

	t.Run("an insight restarts the count", func(t *testing.T) {
		responses := append(silentSteps(4), insightResponse("a finding", "write_file"))
		responses = append(responses, silentSteps(3)...)
		client := newMockClient(append(responses, finalResponse("done"))...)
		runForInsights(t, context.Background(), client, WithInsights(3))
		if got := reminderCalls(client.allCalls()); len(got) != 0 {
			t.Fatalf("reminder in calls %v, want none", got)
		}
	})

	t.Run("not without insights", func(t *testing.T) {
		client := newMockClient(append(silentSteps(8), finalResponse("done"))...)
		runForInsights(t, context.Background(), client)
		if got := reminderCalls(client.allCalls()); len(got) != 0 {
			t.Fatalf("reminder in calls %v, want none", got)
		}
	})
}

package agent

import (
	"context"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestSubtaskEventsIncludeTranscriptAndRequestProgress(t *testing.T) {
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "spawn-1", Name: "spawn", Arguments: map[string]any{"task": "inspect child task", "tools": []any{"probe"}}}}},
		toolCallResponse("probe"), finalResponse("child result"), finalResponse("parent result"),
	)
	reg := tools.NewRegistry()
	if err := reg.Register(stubSubtaskTool{name: "probe"}); err != nil {
		t.Fatal(err)
	}
	sink := &recordingEventSink{}
	ctx := WithEventSinkContext(llmstats.WithRunID(context.Background(), "parent"), sink)
	engine := New(client, reg, Config{DefaultModel: "test-model"}, DefaultPromptSpec())
	if _, _, err := engine.Run(ctx, "parent task", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	var child string
	for _, ev := range sink.all() {
		if ev.Kind == EventKindSubtaskStart {
			child = ev.TaskID
			if ev.RunID != "parent" || ev.Text != "inspect child task" {
				t.Fatalf("subtask start = %+v", ev)
			}
		}
	}
	if child == "" {
		t.Fatal("missing child identity")
	}
	seen := map[string]bool{}
	for _, ev := range sink.all() {
		if ev.RunID != child {
			continue
		}
		seen[ev.Kind] = true
		if ev.Kind == EventKindTurnStart && ev.Model != "test-model" {
			t.Fatalf("child model = %q", ev.Model)
		}
		if ev.Kind == EventKindToolDone && ev.Text != "ok" {
			t.Fatalf("tool output = %q", ev.Text)
		}
		if ev.Kind == EventKindTurnDone && ev.Text != "child result" {
			t.Fatalf("child final output = %q", ev.Text)
		}
	}
	for _, kind := range []string{EventKindLLMStart, EventKindLLMDone, EventKindToolStart, EventKindToolDone, EventKindTurnDone} {
		if !seen[kind] {
			t.Errorf("missing child event %s", kind)
		}
	}
}

type inspectCancelClient struct {
	cancel      context.CancelFunc
	parentCalls int
}

func (c *inspectCancelClient) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	if req.Scene == "spawn.subtask" {
		if c.cancel != nil {
			c.cancel()
		}
		<-ctx.Done()
		return llm.Result{}, ctx.Err()
	}
	c.parentCalls++
	if c.parentCalls > 1 {
		return finalResponse("partial result"), nil
	}
	return llm.Result{ToolCalls: []llm.ToolCall{{ID: "spawn-1", Name: "spawn", Arguments: map[string]any{"task": "child", "tools": []any{"probe"}}}}}, nil
}

func TestSubtaskTerminalEventsSurviveParentCancellation(t *testing.T) {
	for _, mode := range []string{"cancel", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				client := &inspectCancelClient{}
				if mode == "cancel" {
					client.cancel = cancel
				}
				sink := &contextAwareEventSink{}
				ctx = WithEventSinkContext(llmstats.WithRunID(ctx, "parent"), sink)
				reg := tools.NewRegistry()
				_ = reg.Register(stubSubtaskTool{name: "probe"})
				engine := New(client, reg, Config{}, DefaultPromptSpec())
				_, _, _ = engine.Run(ctx, "parent task", RunOptions{})
				synctest.Wait()
				var terminal, done bool
				for _, ev := range sink.all() {
					if ev.Kind == EventKindTurnCanceled && strings.HasPrefix(ev.RunID, "sub_") {
						terminal = true
						want := "context_canceled"
						if mode == "deadline" {
							want = "context_deadline_exceeded"
						}
						if ev.Reason != want {
							t.Fatalf("terminal reason = %q, want %q", ev.Reason, want)
						}
					}
					if ev.Kind == EventKindSubtaskDone {
						done = true
					}
				}
				if !terminal || !done {
					t.Fatalf("lost child completion after %s: terminal=%v done=%v", mode, terminal, done)
				}
			})
		})
	}
}

package taskruntime

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

func TestRuntimeSubtaskInspectionLifecycleAfterCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var events []agent.Event
	ctx = agent.WithEventSinkContext(llmstats.WithRunID(ctx, "parent"), agent.EventSinkFunc(func(ctx context.Context, event agent.Event) {
		if ctx.Err() == nil {
			events = append(events, event)
		}
	}))
	runtime := &Runtime{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	result, err := runtime.RunSubtask(ctx, agent.SubtaskRequest{
		Task: "inspect this task", Model: "test-model",
		RunFunc: func(ctx context.Context) (*agent.SubtaskResult, error) {
			cancel()
			return nil, ctx.Err()
		},
	})
	if err != nil || result == nil || result.Status != "failed" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(events) != 2 || events[0].Kind != agent.EventKindSubtaskStart || events[1].Kind != agent.EventKindSubtaskDone {
		t.Fatalf("missing lifecycle events: %+v", events)
	}
	if events[0].Text != "inspect this task" || events[0].Model != "test-model" || events[0].RunID != "parent" || events[1].TaskID != result.TaskID {
		t.Fatalf("missing or incorrect inspection metadata: %+v", events)
	}
}

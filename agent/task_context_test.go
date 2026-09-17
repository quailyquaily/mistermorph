package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestDeadlineConclusionKeepsValuesAndHonorsParentStop(t *testing.T) {
	for _, when := range []string{"before summary", "during summary error", "during summary success"} {
		t.Run(when, func(t *testing.T) {
			parent, cancelParent := context.WithCancel(context.Background())
			defer cancelParent()
			ctx, cancel := WithTaskTimeout(parent, -time.Second)
			defer cancel()
			type traceKey struct{}
			ctx = context.WithValue(ctx, traceKey{}, "run-value")
			if when == "before summary" {
				cancelParent()
			}
			called := false
			client := deadlineTestClient(func(callCtx context.Context, _ llm.Request) (llm.Result, error) {
				called = true
				if callCtx.Err() != nil || callCtx.Value(traceKey{}) != "run-value" {
					t.Fatalf("summary lost live context or values: err=%v value=%v", callCtx.Err(), callCtx.Value(traceKey{}))
				}
				if _, ok := callCtx.Deadline(); ok {
					t.Fatal("summary inherited expired task deadline")
				}
				cancelParent()
				<-callCtx.Done()
				if when == "during summary success" {
					return finalResponse("late summary"), nil
				}
				return llm.Result{}, callCtx.Err()
			})
			engine := New(client, tools.NewRegistry(), baseCfg(), DefaultPromptSpec())
			final, _, err := engine.forceConclusion(ctx, &engineLoopState{agentCtx: NewContext("work", 1)}, forceConclusionTaskDeadline, nil)
			if !errors.Is(err, context.Canceled) || final != nil {
				t.Fatalf("final=%+v error=%v; want cancellation without publishing", final, err)
			}
			if when == "before summary" && called {
				t.Fatal("called model after parent cancellation")
			}
		})
	}
}

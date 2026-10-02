package agent

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// After message_react, the model may end with an empty final ("the reaction was the reply"). The
// run completes as a lightweight final instead of failing on an invalid response.
func TestRunEndsWithEmptyFinalAfterReaction(t *testing.T) {
	react := llm.ToolCall{ID: "call_react", Name: "message_react", Arguments: map[string]any{"emoji": "👍"}}
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{react}},
		llm.Result{Text: `{"type":"final","output":""}`},
	)
	reg := tools.NewRegistry()
	reg.Register(&mockTool{name: "message_react", result: "sent emoji message: 👍"})
	e := New(client, reg, baseCfg(), DefaultPromptSpec())

	final, _, err := e.Run(context.Background(), "OK OK", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if final == nil || !final.IsLightweight {
		t.Fatalf("final = %+v, want a lightweight final", final)
	}
	calls := client.allCalls()
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(calls))
	}
	if err := calls[1].ValidateResult(llm.Result{Text: `{"type":"final","output":""}`}); err != nil {
		t.Fatalf("the request after the reaction rejects an empty final: %v", err)
	}
	if err := calls[0].ValidateResult(llm.Result{Text: `{"type":"final","output":""}`}); err == nil {
		t.Fatal("the request before any reaction accepts an empty final")
	}
}

// A failed reaction does not excuse an empty final.
func TestEmptyFinalStillInvalidAfterFailedReaction(t *testing.T) {
	react := llm.ToolCall{ID: "call_react", Name: "message_react", Arguments: map[string]any{"emoji": "👍"}}
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{react}},
		llm.Result{Text: `{"type":"final","output":"done"}`},
	)
	reg := tools.NewRegistry()
	reg.Register(&mockTool{name: "message_react", err: context.Canceled})
	e := New(client, reg, baseCfg(), DefaultPromptSpec())
	if _, _, err := e.Run(context.Background(), "OK OK", RunOptions{}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if err := client.allCalls()[1].ValidateResult(llm.Result{Text: `{"type":"final","output":""}`}); err == nil {
		t.Fatal("an empty final is accepted after a failed reaction")
	}
}

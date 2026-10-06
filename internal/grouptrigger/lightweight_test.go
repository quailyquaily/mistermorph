package grouptrigger

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

func lightweightResult(reply, emoji string) *llm.EvaluateResult {
	return &llm.EvaluateResult{
		Emulated: true,
		Answers: map[string]llm.Answer{
			"reply": {Kind: llm.Choice, Selected: reply},
			"emoji": {Kind: llm.Choice, Selected: emoji},
		},
	}
}

func TestDecideLightweight(t *testing.T) {
	tests := []struct {
		name      string
		result    *llm.EvaluateResult
		err       error
		wantEmoji string
		wantErr   error
	}{
		{name: "text", result: lightweightResult("text", "emoji_1")},
		{name: "emoji", result: lightweightResult("emoji", "emoji_1"), wantEmoji: "🙏"},
		{name: "unknown emoji", result: lightweightResult("emoji", "emoji_9"), wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "unknown reply", result: lightweightResult("maybe", "emoji_0"), wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "missing answer", result: &llm.EvaluateResult{Answers: map[string]llm.Answer{}}, wantErr: llm.ErrEvaluateInvalidResponse},
		{name: "evaluate error", err: llm.ErrEvaluateUnsupported, wantErr: llm.ErrEvaluateUnsupported},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &evaluationStub{result: tt.result, err: tt.err}
			emoji, err := DecideLightweight(context.Background(), LightweightOptions{
				Client:         client,
				Model:          "fast",
				Scene:          "test.lightweight",
				CurrentMessage: map[string]any{"text": "thanks!"},
				Emojis:         []string{"👍", "🙏"},
			})
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if emoji != tt.wantEmoji {
				t.Fatalf("emoji = %q, want %q", emoji, tt.wantEmoji)
			}
			if len(client.calls) != 1 {
				t.Fatalf("calls = %d, want 1", len(client.calls))
			}
			req := client.calls[0]
			if len(req.Questions) != 2 || len(req.Questions["reply"].Options) != 2 {
				t.Fatalf("questions = %#v, want the two-way reply and the emoji choice", req.Questions)
			}
			if got := len(req.Questions["emoji"].Options); got != 2 {
				t.Fatalf("emoji options = %d, want 2", got)
			}
			if !strings.Contains(req.State.(string), "thanks!") {
				t.Fatalf("state does not carry the current message: %v", req.State)
			}
		})
	}
}

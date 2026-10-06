package core

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/grouptrigger"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

type lightweightEvaluator struct {
	reply    string
	err      error
	requests []llm.EvaluateRequest
}

func (e *lightweightEvaluator) Chat(context.Context, llm.Request) (llm.Result, error) {
	panic("unexpected Chat")
}

func (e *lightweightEvaluator) Evaluate(_ context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	e.requests = append(e.requests, req)
	if e.err != nil {
		return nil, e.err
	}
	return &llm.EvaluateResult{Emulated: true, Answers: map[string]llm.Answer{
		"reply": {Kind: llm.Choice, Selected: e.reply},
		"emoji": {Kind: llm.Choice, Selected: "emoji_0"},
	}}, nil
}

func TestLightweightPrecheckApplies(t *testing.T) {
	tests := []struct {
		text        string
		attachments bool
		want        bool
	}{
		{text: "thanks!", want: true},
		{text: "  ", want: false},
		{text: "thanks!", attachments: true, want: false},
		{text: "/think about it", want: false},
	}
	for _, tt := range tests {
		if got := LightweightPrecheckApplies(tt.text, tt.attachments); got != tt.want {
			t.Errorf("LightweightPrecheckApplies(%q, %v) = %v, want %v", tt.text, tt.attachments, got, tt.want)
		}
	}
}

func TestRunLightweightPrecheck(t *testing.T) {
	bundleFor := func(client llm.Client) *ChannelRuntimeBundle {
		return &ChannelRuntimeBundle{
			AddressingClient:    client,
			AddressingModel:     "fast",
			AddressingRoute:     llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{RequestTimeout: time.Second}},
			LightweightPrecheck: true,
		}
	}
	firstEmoji := grouptrigger.DefaultLightweightEmojis[0]
	tests := []struct {
		name       string
		shared     bool
		reply      string
		evalErr    error
		deliverErr error
		want       PrecheckResult
		wantEmoji  string
		wantSent   string
		wantCalls  int
	}{
		{name: "decision shares the main profile", shared: true, reply: "emoji", want: PrecheckSkipped},
		{name: "text", reply: "text", want: PrecheckText, wantCalls: 1},
		{name: "emoji delivered", reply: "emoji", want: PrecheckHandled, wantEmoji: firstEmoji, wantSent: firstEmoji, wantCalls: 1},
		{name: "deliver fails", reply: "emoji", deliverErr: errors.New("send failed"), want: PrecheckSkipped, wantSent: firstEmoji, wantCalls: 1},
		{name: "evaluate fails", evalErr: errors.New("timeout"), want: PrecheckSkipped, wantCalls: 1},
		{name: "evaluate unsupported", evalErr: llm.ErrEvaluateUnsupported, want: PrecheckSkipped, wantCalls: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &lightweightEvaluator{reply: tt.reply, err: tt.evalErr}
			bundle := bundleFor(client)
			bundle.LightweightPrecheck = !tt.shared
			sent := ""
			got, emoji := RunLightweightPrecheck(context.Background(), bundle, LightweightPrecheckRequest{
				Scene:          "test.lightweight_decision",
				CurrentMessage: map[string]any{"text": "thanks!"},
				Deliver: func(_ context.Context, emoji string) error {
					sent = emoji
					return tt.deliverErr
				},
			})
			if got != tt.want || emoji != tt.wantEmoji || sent != tt.wantSent {
				t.Fatalf("result = (%v, %q), sent = %q; want (%v, %q), sent %q", got, emoji, sent, tt.want, tt.wantEmoji, tt.wantSent)
			}
			if len(client.requests) != tt.wantCalls {
				t.Fatalf("calls = %d, want %d", len(client.requests), tt.wantCalls)
			}
			if tt.wantCalls == 0 {
				return
			}
			req := client.requests[0]
			if req.Model != "fast" || req.Scene != "test.lightweight_decision" {
				t.Fatalf("request model/scene = %q/%q", req.Model, req.Scene)
			}
			if got, want := len(req.Questions["emoji"].Options), len(grouptrigger.DefaultLightweightEmojis); got != want {
				t.Fatalf("emoji options = %d, want the default emojis (%d)", got, want)
			}
		})
	}
}

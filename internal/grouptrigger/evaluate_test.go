package grouptrigger

import (
	"context"
	"errors"
	"fmt"
	"github.com/quailyquaily/mistermorph/llm"
	"math"
	"testing"
)

type evaluationStub struct {
	result *llm.EvaluateResult
	err    error
	calls  []llm.EvaluateRequest
}

func TestEvaluateLimitsReactionOptions(t *testing.T) {
	r := judgmentResult()
	r.Answers["reply"] = llm.Answer{Kind: llm.Choice, Selected: "text"}
	c := &evaluationStub{result: r}
	emojis := []string{"", "👍", "👍"}
	for i := 0; i < 300; i++ {
		emojis = append(emojis, fmt.Sprintf("emoji_%d", i))
	}
	_, _, err := DecideViaLLM(context.Background(), LLMDecisionOptions{Client: c, ReactionEmojis: emojis})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(c.calls[0].Questions["emoji"].Options); got != 255 {
		t.Fatalf("options=%d want 255", got)
	}
}

func (s *evaluationStub) Chat(context.Context, llm.Request) (llm.Result, error) {
	panic("unexpected Chat")
}
func (s *evaluationStub) Evaluate(_ context.Context, r llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	s.calls = append(s.calls, r)
	return s.result, s.err
}

type reactionStub struct {
	execCount int
	lastEmoji string
	err       error
}

func (s *reactionStub) react(_ context.Context, emoji string) error {
	s.execCount++
	s.lastEmoji = emoji
	return s.err
}

func judgmentResult() *llm.EvaluateResult {
	score := 8.0
	return &llm.EvaluateResult{Emulated: true, Answers: map[string]llm.Answer{
		"confidence": {Kind: llm.Score, ScoreValue: &score}, "interject": {Kind: llm.Score, ScoreValue: &score}, "impulse": {Kind: llm.Score, ScoreValue: &score},
		"reply": {Kind: llm.Choice, Selected: "emoji"}, "emoji": {Kind: llm.Choice, Selected: "emoji_0"},
	}}
}

func TestEvaluateDecisionDoesNotSendBeforeGate(t *testing.T) {
	for _, allow := range []bool{false, true} {
		client := &evaluationStub{result: judgmentResult()}
		tool := &reactionStub{}
		result, ok, err := DecideViaLLM(context.Background(), LLMDecisionOptions{Client: client, SystemPrompt: "persona", UserPrompt: `{"text":"Hi"}`, ReactionEmojis: []string{"👍"}})
		if err != nil || !ok {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
		if len(client.calls) != 1 || tool.execCount != 0 {
			t.Fatal("judgment performed side effect")
		}
		if client.calls[0].Questions["emoji"].Options["emoji_0"] != "👍" {
			t.Fatal("missing constrained reaction")
		}
		if !allow {
			result.Confidence = 0.6
		}
		dec, accepted, err := Decide(context.Background(), DecideOptions{Mode: "smart", ConfidenceThreshold: .7, React: tool.react, Addressing: func(context.Context) (Addressing, bool, error) { return result, true, nil }})
		if err != nil || accepted != allow || dec.ReactionHandled != allow {
			t.Fatalf("dec=%+v accepted=%v err=%v", dec, accepted, err)
		}
		want := 0
		if allow {
			want = 1
		}
		if tool.execCount != want {
			t.Fatalf("sends=%d", tool.execCount)
		}
	}
}

func TestEvaluateDecisionRejectsInvalidAnswers(t *testing.T) {
	for _, mutate := range []func(*llm.EvaluateResult){
		func(r *llm.EvaluateResult) { delete(r.Answers, "confidence") },
		func(r *llm.EvaluateResult) {
			r.Answers["interject"] = llm.Answer{Kind: llm.Choice, Selected: "text"}
		},
		func(r *llm.EvaluateResult) {
			r.Answers["emoji"] = llm.Answer{Kind: llm.Choice, Selected: "arbitrary"}
		},
		func(r *llm.EvaluateResult) {
			n := math.NaN()
			r.Answers["confidence"] = llm.Answer{Kind: llm.Score, ScoreValue: &n}
		},
		func(r *llm.EvaluateResult) {
			n := 10.0
			r.Answers["confidence"] = llm.Answer{Kind: llm.Score, ScoreValue: &n}
		},
		func(r *llm.EvaluateResult) {
			n := 1.5
			r.Answers["confidence"] = llm.Answer{Kind: llm.Score, ScoreValue: &n}
		},
	} {
		r := judgmentResult()
		mutate(r)
		_, ok, err := DecideViaLLM(context.Background(), LLMDecisionOptions{Client: &evaluationStub{result: r}, ReactionEmojis: []string{"👍"}})
		if ok || !errors.Is(err, llm.ErrEvaluateInvalidResponse) {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	}
}

func TestEvaluateDecisionNativeAndNoReaction(t *testing.T) {
	r := judgmentResult()
	r.Emulated = false
	confidence, interject := 4.5, 9.0
	r.Answers["confidence"] = llm.Answer{Kind: llm.Score, ScoreValue: &confidence}
	r.Answers["interject"] = llm.Answer{Kind: llm.Score, ScoreValue: &interject}
	delete(r.Answers, "reply")
	delete(r.Answers, "emoji")
	c := &evaluationStub{result: r}
	got, ok, err := DecideViaLLM(context.Background(), LLMDecisionOptions{Client: c})
	if err != nil || !ok || got.Confidence != 0.5 || got.Interject != 1 || got.IsLightweight {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if len(c.calls[0].Questions) != 3 {
		t.Fatalf("questions = %d, want only confidence, interject and impulse without emojis", len(c.calls[0].Questions))
	}
}

func TestDecisionReactionFailureAndCancellation(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		tool := &reactionStub{err: errors.New("send failed")}
		_, accepted, err := Decide(ctx, DecideOptions{Mode: "smart", React: tool.react, Addressing: func(context.Context) (Addressing, bool, error) {
			if cancelled {
				cancel()
			}
			return Addressing{Confidence: 1, IsLightweight: true, Reaction: "👍"}, true, nil
		}})
		if err == nil || accepted {
			t.Fatal("failure accepted")
		}
		if cancelled && tool.execCount != 0 {
			t.Fatal("sent after cancellation")
		}
	}
}

func TestEvaluateAsksTextOrEmojiApartFromWhichEmoji(t *testing.T) {
	emojis := []string{"👍", "👀", "🎉"}
	for _, tt := range []struct {
		reply     string
		wantEmoji string
	}{
		{reply: "text"},
		{reply: "emoji", wantEmoji: "👀"},
	} {
		r := judgmentResult()
		r.Answers["reply"] = llm.Answer{Kind: llm.Choice, Selected: tt.reply}
		r.Answers["emoji"] = llm.Answer{Kind: llm.Choice, Selected: "emoji_1"}
		c := &evaluationStub{result: r}
		got, _, err := DecideViaLLM(context.Background(), LLMDecisionOptions{Client: c, ReactionEmojis: emojis})
		if err != nil {
			t.Fatal(err)
		}
		if got.Reaction != tt.wantEmoji || got.IsLightweight != (tt.wantEmoji != "") {
			t.Fatalf("reply %q: got %+v, want emoji %q", tt.reply, got, tt.wantEmoji)
		}
		reply := c.calls[0].Questions["reply"].Options
		if len(reply) != 2 || reply["text"] == nil || reply["emoji"] == nil {
			t.Fatalf("reply options = %v, want only text and emoji", reply)
		}
		if got := len(c.calls[0].Questions["emoji"].Options); got != len(emojis) {
			t.Fatalf("emoji options = %d, want %d", got, len(emojis))
		}
	}
}

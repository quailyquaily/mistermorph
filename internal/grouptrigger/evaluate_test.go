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
	r.Answers["response"] = llm.Answer{Kind: llm.Choice, Selected: "text"}
	c := &evaluationStub{result: r}
	emojis := []string{"", "👍", "👍"}
	for i := 0; i < 300; i++ {
		emojis = append(emojis, fmt.Sprintf("emoji_%d", i))
	}
	_, _, err := DecideViaLLM(context.Background(), LLMDecisionOptions{Client: c, ReactionEmojis: emojis})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(c.calls[0].Questions["response"].Options); got != 255 {
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

func (s *reactionStub) Name() string            { return "message_react" }
func (s *reactionStub) Description() string     { return "react" }
func (s *reactionStub) ParameterSchema() string { return `{}` }
func (s *reactionStub) Execute(_ context.Context, p map[string]any) (string, error) {
	s.execCount++
	s.lastEmoji, _ = p["emoji"].(string)
	return "ok", s.err
}

func judgmentResult() *llm.EvaluateResult {
	yes := true
	score := 8.0
	return &llm.EvaluateResult{Emulated: true, Answers: map[string]llm.Answer{
		"addressed": {Kind: llm.Boolean, BooleanValue: &yes}, "wanna_interject": {Kind: llm.Boolean, BooleanValue: &yes},
		"confidence": {Kind: llm.Score, ScoreValue: &score}, "interject": {Kind: llm.Score, ScoreValue: &score}, "impulse": {Kind: llm.Score, ScoreValue: &score},
		"response": {Kind: llm.Choice, Selected: "reaction_0"},
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
		if client.calls[0].Questions["response"].Options["reaction_0"] != "👍" {
			t.Fatal("missing constrained reaction")
		}
		result.Addressed = allow
		dec, accepted, err := Decide(context.Background(), DecideOptions{Mode: "smart", ConfidenceThreshold: .7, ReactionTool: tool, Addressing: func(context.Context) (Addressing, bool, error) { return result, true, nil }})
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
		func(r *llm.EvaluateResult) { delete(r.Answers, "addressed") },
		func(r *llm.EvaluateResult) {
			r.Answers["response"] = llm.Answer{Kind: llm.Choice, Selected: "arbitrary"}
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
	p := .5
	r.Answers["addressed"] = llm.Answer{Kind: llm.Boolean, ProbabilityTrue: &p}
	p2 := .9
	r.Answers["wanna_interject"] = llm.Answer{Kind: llm.Boolean, ProbabilityTrue: &p2}
	r.Answers["response"] = llm.Answer{Kind: llm.Choice, Selected: "text"}
	c := &evaluationStub{result: r}
	got, ok, err := DecideViaLLM(context.Background(), LLMDecisionOptions{Client: c})
	if err != nil || !ok || got.Addressed || !got.WannaInterject || got.IsLightweight {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if len(c.calls[0].Questions["response"].Options) != 1 {
		t.Fatal("reaction offered without tool")
	}
}

func TestDecisionReactionFailureAndCancellation(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		tool := &reactionStub{err: errors.New("send failed")}
		_, accepted, err := Decide(ctx, DecideOptions{Mode: "smart", ReactionTool: tool, Addressing: func(context.Context) (Addressing, bool, error) {
			if cancelled {
				cancel()
			}
			return Addressing{Addressed: true, Confidence: 1, IsLightweight: true, Reaction: "👍"}, true, nil
		}})
		if err == nil || accepted {
			t.Fatal("failure accepted")
		}
		if cancelled && tool.execCount != 0 {
			t.Fatal("sent after cancellation")
		}
	}
}

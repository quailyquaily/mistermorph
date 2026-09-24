package llmutil

import (
	"context"
	"errors"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/llm"
	"testing"
)

type evaluationStub struct {
	calls []llm.EvaluateRequest
	err   error
}

func TestWeightedEvaluateAndCancellation(t *testing.T) {
	a, b := &evaluationStub{}, &evaluationStub{}
	c := &weightedRouteClient{candidates: []weightedRouteCandidate{{Client: a, Model: "a", Weight: 1}, {Client: b, Model: "b", Weight: 1}}}
	ctx := llmstats.WithRunID(context.Background(), "same-run")
	for i := 0; i < 4; i++ {
		if _, err := c.Evaluate(ctx, llm.EvaluateRequest{}); err != nil {
			t.Fatal(err)
		}
	}
	if len(a.calls) != 4 && len(b.calls) != 4 {
		t.Fatal("selection changed within a run")
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	cancel()
	_, err := c.Evaluate(cancelCtx, llm.EvaluateRequest{})
	if !errors.Is(err, context.Canceled) || len(a.calls)+len(b.calls) != 4 {
		t.Fatal("called after cancellation")
	}
}

func (s *evaluationStub) Chat(context.Context, llm.Request) (llm.Result, error) {
	panic("Evaluate must not call Chat")
}
func (s *evaluationStub) Evaluate(_ context.Context, r llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	s.calls = append(s.calls, r)
	return &llm.EvaluateResult{Model: r.Model}, s.err
}

func TestEvaluateProfileFallback(t *testing.T) {
	for _, tt := range []struct {
		name         string
		err          error
		wantFallback bool
	}{
		{"rate limit", errors.New("http 429"), true},
		{"invalid answer", llm.ErrEvaluateInvalidResponse, false},
		{"invalid request", llm.ErrEvaluateInvalidRequest, false},
		{"unsupported", llm.ErrEvaluateUnsupported, false},
		{"cancel", context.Canceled, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			first := &evaluationStub{err: tt.err}
			second := &evaluationStub{}
			c := NewFallbackClient(FallbackClientOptions{Primary: first, PrimaryModel: "judge", Fallbacks: []FallbackCandidate{{Client: second, Model: "backup"}}})
			evaluator, ok := c.(llm.Evaluator)
			if !ok {
				t.Fatal("lost Evaluate capability")
			}
			res, err := evaluator.Evaluate(context.Background(), llm.EvaluateRequest{Model: "judge"})
			if len(first.calls) != 1 {
				t.Fatalf("primary attempts=%d", len(first.calls))
			}
			if tt.wantFallback {
				if err != nil || res.Model != "backup" || len(second.calls) != 1 {
					t.Fatalf("result=%+v err=%v", res, err)
				}
			} else if !errors.Is(err, tt.err) || len(second.calls) != 0 {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

package llmutil_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/outputfmt"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type responseRetryClient struct {
	chat func(context.Context, llm.Request) (llm.Result, error)
}

func (c responseRetryClient) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	return c.chat(ctx, req)
}

func TestAgentRetriesEmptyFinalOnSameRequest(t *testing.T) {
	for _, first := range []llm.Result{
		{Text: `{"type":"final","output":null}`},
		{Text: `{"type":"final"}`},
		{Text: `{"type":"final_answer","output":""}`},
		{Text: `{"type":"final","output":" \n\t"}`},
		{Text: `{"type":"final","output":"null"}`},
		{Text: `{"type":"final","final":{"output":"answer"}}`},
		{JSON: map[string]any{"type": "final", "output": nil}},
		{Text: "null"}, {},
	} {
		t.Run(fmt.Sprint(first), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls []time.Time
				var messages []llm.Message
				client := llmutil.NewFallbackClient(llmutil.FallbackClientOptions{Primary: responseRetryClient{chat: func(_ context.Context, req llm.Request) (llm.Result, error) {
					calls = append(calls, time.Now())
					if len(calls) == 1 {
						messages = append([]llm.Message(nil), req.Messages...)
						return first, nil
					}
					if !reflect.DeepEqual(req.Messages, messages) || req.Model != "main" {
						t.Fatal("retry changed the conversation or model")
					}
					return llm.Result{Text: `{"type":"final","output":"answer"}`}, nil
				}}})
				engine := agent.New(client, tools.NewRegistry(), agent.Config{MaxSteps: 1, ParseRetries: 0}, agent.DefaultPromptSpec())
				final, _, err := engine.Run(context.Background(), "question", agent.RunOptions{Model: "main"})
				if err != nil || outputfmt.FormatFinalOutput(final) != "answer" || len(calls) != 2 {
					t.Fatalf("final=%+v err=%v calls=%d", final, err, len(calls))
				}
				if delay := calls[1].Sub(calls[0]); delay < 500*time.Millisecond || delay > time.Second {
					t.Fatalf("retry delay=%s", delay)
				}
			})
		})
	}
}

func TestAgentEmptyFinalExhaustionAndFallback(t *testing.T) {
	for _, outcome := range []string{"no fallback", "fallback succeeds", "fallback empty"} {
		t.Run(outcome, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var models []string
				var calls []time.Time
				provider := responseRetryClient{chat: func(_ context.Context, req llm.Request) (llm.Result, error) {
					models = append(models, req.Model)
					calls = append(calls, time.Now())
					if req.Model == "backup" && outcome == "fallback succeeds" {
						return llm.Result{Text: `{"type":"final","output":"answer"}`}, nil
					}
					return llm.Result{Text: `{"type":"final","output":null}`}, nil
				}}
				opts := llmutil.FallbackClientOptions{Primary: provider}
				wantModels := []string{"main", "main", "main", "main", "main", "main"}
				if outcome != "no fallback" {
					opts.Fallbacks = []llmutil.FallbackCandidate{{Model: "backup", Client: provider}}
					wantModels = append(wantModels, "backup")
					if outcome == "fallback empty" {
						wantModels = append(wantModels, "backup", "backup", "backup", "backup", "backup")
					}
				}
				engine := agent.New(llmutil.NewFallbackClient(opts), tools.NewRegistry(), agent.Config{MaxSteps: 2}, agent.DefaultPromptSpec())
				final, _, err := engine.Run(context.Background(), "question", agent.RunOptions{Model: "main"})
				if outcome == "fallback succeeds" {
					if err != nil || outputfmt.FormatFinalOutput(final) != "answer" {
						t.Fatalf("final=%+v err=%v", final, err)
					}
				} else if !errors.Is(err, agent.ErrInvalidFinal) || final != nil {
					t.Fatalf("final=%+v err=%v, want invalid final error", final, err)
				}
				if !reflect.DeepEqual(models, wantModels) {
					t.Fatalf("models=%v, want %v", models, wantModels)
				}
				for i := 1; i < 6; i++ {
					limit := time.Second << (i - 1)
					if delay := calls[i].Sub(calls[i-1]); delay < limit/2 || delay > limit {
						t.Fatalf("retry %d delay=%s", i, delay)
					}
				}
			})
		})
	}
}

func TestAgentEmptyFinalRetryStopsOnCancel(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		calls := 0
		provider := responseRetryClient{chat: func(context.Context, llm.Request) (llm.Result, error) {
			calls++
			time.AfterFunc(100*time.Millisecond, cancel)
			return llm.Result{Text: `{"type":"final","output":null}`}, nil
		}}
		client := llmutil.NewFallbackClient(llmutil.FallbackClientOptions{Primary: provider, Fallbacks: []llmutil.FallbackCandidate{{Client: provider}}})
		engine := agent.New(client, tools.NewRegistry(), agent.Config{MaxSteps: 2}, agent.DefaultPromptSpec())
		final, _, err := engine.Run(ctx, "question", agent.RunOptions{})
		if !errors.Is(err, context.Canceled) || final != nil || calls != 1 {
			t.Fatalf("final=%+v err=%v calls=%d", final, err, calls)
		}
	})
}

func TestAgentForcedConclusionRetriesEmptyFinal(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		calls := 0
		client := llmutil.NewFallbackClient(llmutil.FallbackClientOptions{Primary: responseRetryClient{chat: func(_ context.Context, req llm.Request) (llm.Result, error) {
			calls++
			if calls == 1 {
				return llm.Result{Text: "not JSON"}, nil
			}
			if !strings.Contains(req.Messages[len(req.Messages)-1].Content, "Provide your final output NOW") {
				t.Fatal("expected forced conclusion request")
			}
			if calls == 2 {
				return llm.Result{Text: `{"type":"final","output":null}`}, nil
			}
			return llm.Result{Text: `{"type":"final","output":"summary"}`}, nil
		}}})
		engine := agent.New(client, tools.NewRegistry(), agent.Config{MaxSteps: 1, ParseRetries: 0}, agent.DefaultPromptSpec())
		final, _, err := engine.Run(context.Background(), "question", agent.RunOptions{})
		if err != nil || outputfmt.FormatFinalOutput(final) != "summary" || calls != 3 {
			t.Fatalf("final=%+v err=%v calls=%d", final, err, calls)
		}
	})
}

package llmbench

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

type evaluateStub struct {
	result *llm.EvaluateResult
	err    error
	chats  int
}

func (s *evaluateStub) Chat(context.Context, llm.Request) (llm.Result, error) {
	s.chats++
	return llm.Result{Text: "ok"}, nil
}

func (s *evaluateStub) Evaluate(context.Context, llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	return s.result, s.err
}

type chatOnlyStub struct{}

func (chatOnlyStub) Chat(context.Context, llm.Request) (llm.Result, error) {
	return llm.Result{Text: "ok"}, nil
}

func judgment(emulated bool, asks bool, reply string) *llm.EvaluateResult {
	answers := map[string]llm.Answer{"reply": {Kind: llm.Choice, Selected: reply}}
	if emulated {
		answers["asks"] = llm.Answer{Kind: llm.Boolean, BooleanValue: &asks}
	} else {
		p := 0.1
		if asks {
			p = 0.9
		}
		answers["asks"] = llm.Answer{Kind: llm.Boolean, ProbabilityTrue: &p}
	}
	return &llm.EvaluateResult{Emulated: emulated, Answers: answers}
}

func TestRunEvaluateBenchmark(t *testing.T) {
	tests := []struct {
		name   string
		client llm.Client
		wantOK bool
	}{
		{name: "native", client: &evaluateStub{result: judgment(false, true, "text")}, wantOK: true},
		{name: "emulated", client: &evaluateStub{result: judgment(true, true, "text")}, wantOK: true},
		{name: "wrong reply", client: &evaluateStub{result: judgment(true, true, "emoji")}},
		{name: "wrong yes/no", client: &evaluateStub{result: judgment(false, false, "text")}},
		{name: "missing answers", client: &evaluateStub{result: &llm.EvaluateResult{}}},
		{name: "unsupported", client: chatOnlyStub{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RunEvaluateBenchmark(context.Background(), tt.client, "judge")
			if got.ID != "evaluate" || got.OK != tt.wantOK {
				t.Fatalf("result = %+v, want ok = %v", got, tt.wantOK)
			}
			if !got.OK && got.Error == "" {
				t.Fatal("failure without an error")
			}
		})
	}
}

func TestRunWithProgressEvaluateOnlyProvider(t *testing.T) {
	client := &evaluateStub{result: judgment(false, true, "text")}
	result := Run(context.Background(), client, ProfileMetadata{Provider: "typesafe", Model: "jev"})
	if len(result.Benchmarks) != 1 || result.Benchmarks[0].ID != "evaluate" || !result.OK() || client.chats != 0 {
		t.Fatalf("result = %+v, chats = %d; want only the Evaluate benchmark", result, client.chats)
	}
	if BenchmarkCount("typesafe") != 1 || BenchmarkCount("openai") != BenchmarksPerRun {
		t.Fatal("benchmark counts do not match what Run runs")
	}
	chat := Run(context.Background(), &evaluateStub{result: judgment(true, true, "text")}, ProfileMetadata{Provider: "openai"})
	if len(chat.Benchmarks) != BenchmarksPerRun || chat.Benchmarks[BenchmarksPerRun-1].ID != "evaluate" {
		t.Fatalf("chat profile benchmarks = %d, want %d ending with evaluate", len(chat.Benchmarks), BenchmarksPerRun)
	}
}

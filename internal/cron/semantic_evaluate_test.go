package cron

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

type matcherStub struct {
	selected  string
	evalErr   error
	evaluated int
	chats     int
	requests  []llm.EvaluateRequest
}

func (s *matcherStub) Chat(context.Context, llm.Request) (llm.Result, error) {
	s.chats++
	return llm.Result{Text: `{"status":"matched","index":0}`}, nil
}

func (s *matcherStub) Evaluate(_ context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	s.evaluated++
	s.requests = append(s.requests, req)
	if s.evalErr != nil {
		return nil, s.evalErr
	}
	return &llm.EvaluateResult{Emulated: true, Answers: map[string]llm.Answer{"task": {Kind: llm.Choice, Selected: s.selected}}}, nil
}

func TestMatchTaskIndexOnDecisionRoute(t *testing.T) {
	tasks := []Task{{Content: "water the plants"}, {Content: "call mom"}, {Content: "pay rent"}}
	tests := []struct {
		name      string
		selected  string
		evalErr   error
		want      int
		wantErr   string
		wantChats int
	}{
		{name: "matched", selected: "task_1", want: 1},
		{name: "no match", selected: "no_match", want: -1, wantErr: "no matching cron task"},
		{name: "ambiguous", selected: "ambiguous", want: -1, wantErr: "ambiguous"},
		{name: "invalid", selected: "task_9", want: -1, wantErr: "invalid evaluate response"},
		{name: "evaluate unsupported", evalErr: llm.ErrEvaluateUnsupported, want: 0, wantChats: 1},
		{name: "evaluate failed", evalErr: errors.New("timeout"), want: -1, wantErr: "timeout"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision := &matcherStub{selected: tt.selected, evalErr: tt.evalErr}
			main := &matcherStub{}
			resolver := NewLLMSemanticResolver(main, "main")
			resolver.Decision, resolver.DecisionModel = decision, "fast"
			got, err := resolver.MatchTaskIndex(context.Background(), "stop calling mom", tasks)
			if got != tt.want || (tt.wantErr == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), tt.wantErr)) {
				t.Fatalf("MatchTaskIndex() = %d, %v; want %d, %q", got, err, tt.want, tt.wantErr)
			}
			if main.chats != tt.wantChats {
				t.Fatalf("main chats = %d, want %d", main.chats, tt.wantChats)
			}
			if len(decision.requests[0].Questions["task"].Options) != len(tasks)+2 {
				t.Fatalf("options = %v, want one per task plus no_match and ambiguous", decision.requests[0].Questions["task"].Options)
			}
		})
	}
}

func TestMatchTaskIndexUsesChatWhenTasksDoNotFit(t *testing.T) {
	tasks := make([]Task, maxEvaluateTasks+1)
	decision, main := &matcherStub{selected: "task_0"}, &matcherStub{}
	resolver := NewLLMSemanticResolver(main, "main")
	resolver.Decision = decision
	if _, err := resolver.MatchTaskIndex(context.Background(), "anything", tasks); err != nil {
		t.Fatal(err)
	}
	if decision.evaluated != 0 || main.chats != 1 {
		t.Fatalf("evaluated = %d, chats = %d; want the Chat path", decision.evaluated, main.chats)
	}
}

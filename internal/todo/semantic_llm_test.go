package todo

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/entryutil"
	"github.com/quailyquaily/mistermorph/llm"
)

type stubTodoLLMClient struct {
	replies []string
	err     error
	calls   []llm.Request
}

func (s *stubTodoLLMClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	s.calls = append(s.calls, req)
	if s.err != nil {
		return llm.Result{}, s.err
	}
	if len(s.replies) == 0 {
		return llm.Result{}, fmt.Errorf("no more stub replies")
	}
	reply := s.replies[0]
	s.replies = s.replies[1:]
	return llm.Result{Text: reply}, nil
}

func TestLLMSemanticResolverSelectDedupKeepIndices(t *testing.T) {
	client := &stubTodoLLMClient{
		replies: []string{`{"keep_indices":[0,2,2]}`},
	}
	resolver := NewLLMSemanticResolver(client, "gpt-5.2")
	indices, err := resolver.SelectDedupKeepIndices(context.Background(), []entryutil.SemanticItem{
		{CreatedAt: "2026-02-09 10:00", Content: "A"},
		{CreatedAt: "2026-02-09 10:01", Content: "B"},
		{CreatedAt: "2026-02-09 10:02", Content: "C"},
	})
	if err != nil {
		t.Fatalf("SelectDedupKeepIndices() error = %v", err)
	}
	if len(indices) != 2 || indices[0] != 0 || indices[1] != 2 {
		t.Fatalf("unexpected keep indices: %#v", indices)
	}
	if len(client.calls) != 1 || !client.calls[0].ForceJSON {
		t.Fatalf("expected one ForceJSON request")
	}
}

func TestLLMSemanticResolverMatchCompleteIndexAmbiguous(t *testing.T) {
	client := &stubTodoLLMClient{
		replies: []string{`{"status":"ambiguous","candidate_indices":[0,1]}`},
	}
	resolver := NewLLMSemanticResolver(client, "gpt-5.2")
	_, err := resolver.MatchCompleteIndex(context.Background(), "发消息", []Entry{
		{CreatedAt: "2026-02-09 10:00", Content: "给 John 发消息"},
		{CreatedAt: "2026-02-09 10:01", Content: "给 Momo 发消息"},
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "ambiguous") {
		t.Fatalf("expected ambiguous error, got %v", err)
	}
}

func TestLLMSemanticResolverRejectsNonStrictJSON(t *testing.T) {
	client := &stubTodoLLMClient{
		replies: []string{"```json\n{\"keep_indices\":[0]}\n```"},
	}
	resolver := NewLLMSemanticResolver(client, "gpt-5.2")
	_, err := resolver.SelectDedupKeepIndices(context.Background(), []entryutil.SemanticItem{
		{CreatedAt: "2026-02-09 10:00", Content: "A"},
		{CreatedAt: "2026-02-09 10:01", Content: "B"},
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "invalid semantic_dedup response") {
		t.Fatalf("expected strict-json parse error, got %v", err)
	}
}

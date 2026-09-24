package llmstats

import (
	"context"
	"encoding/json"
	"github.com/quailyquaily/mistermorph/llm"
	"os"
	"path/filepath"
	"testing"
)

type failedEvaluator struct{}

func (failedEvaluator) Chat(context.Context, llm.Request) (llm.Result, error) {
	panic("unexpected Chat")
}
func (failedEvaluator) Evaluate(context.Context, llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	n := 10
	return &llm.EvaluateResult{Model: "actual-model", Emulated: true, Usage: &llm.EvaluateUsage{InputTokens: &n, Details: llm.Usage{InputTokens: 10}}}, llm.ErrEvaluateInvalidResponse
}
func TestEvaluateRecordsUsageOnError(t *testing.T) {
	dir := t.TempDir()
	c := WrapClient(failedEvaluator{}, ClientOptions{JournalDir: dir, Provider: "openai", DefaultModel: "alias"})
	defer c.(*UsageClient).Close()
	_, err := llm.Evaluate(context.Background(), c, llm.EvaluateRequest{Scene: "telegram.addressing_decision"})
	if err != llm.ErrEvaluateInvalidResponse {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("journal files=%d", len(entries))
	}
	data, err := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	var rec RequestRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Operation != "evaluate" || rec.Model != "actual-model" || rec.InputTokens != 10 {
		t.Fatalf("record=%+v", rec)
	}
	if rec.Evaluation == nil || !rec.Evaluation.Failed || !rec.Evaluation.Emulated || rec.Evaluation.Usage.OutputTokens != nil {
		t.Fatalf("lost evaluation metadata: %+v", rec.Evaluation)
	}
}

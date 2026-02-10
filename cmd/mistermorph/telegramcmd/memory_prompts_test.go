package telegramcmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/memory"
)

func TestRenderMemoryDraftPrompts(t *testing.T) {
	sys, user, err := renderMemoryDraftPrompts(
		MemoryDraftContext{SessionID: "tg:1", ChatType: "private"},
		[]map[string]string{{"role": "user", "content": "hi"}},
		memory.ShortTermContent{
			SummaryItems: []memory.SummaryItem{{Created: "2026-02-11 09:30", Content: "The agent discussed progress with [Alice](tg:@alice)."}},
		},
	)
	if err != nil {
		t.Fatalf("renderMemoryDraftPrompts() error = %v", err)
	}
	if !strings.Contains(sys, "single agent session") {
		t.Fatalf("unexpected system prompt: %q", sys)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(user), &payload); err != nil {
		t.Fatalf("user prompt is not valid json: %v", err)
	}
	if payload["session_context"] == nil {
		t.Fatalf("missing session_context")
	}
	if payload["rules"] == nil {
		t.Fatalf("missing rules")
	}
	if payload["existing_summary_items"] == nil {
		t.Fatalf("missing existing memory payload")
	}
}

package telegramcmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/memory"
)

func TestRenderMemoryDraftPrompts(t *testing.T) {
	sys, user, err := renderMemoryDraftPrompts(
		MemoryDraftContext{SessionID: "telegram:1", ChatType: "private"},
		[]map[string]string{{"role": "user", "content": "hi"}},
		[]memory.TaskItem{{Text: "t1", Done: false}},
		[]memory.TaskItem{{Text: "f1", Done: false}},
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
}

func TestRenderMemoryMergePrompts(t *testing.T) {
	sys, user, err := renderMemoryMergePrompts(
		semanticMergeContent{Tasks: []memory.TaskItem{{Text: "a"}}},
		semanticMergeContent{Tasks: []memory.TaskItem{{Text: "b"}}},
	)
	if err != nil {
		t.Fatalf("renderMemoryMergePrompts() error = %v", err)
	}
	if !strings.Contains(sys, "merge short-term memory entries") {
		t.Fatalf("unexpected system prompt: %q", sys)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(user), &payload); err != nil {
		t.Fatalf("user prompt is not valid json: %v", err)
	}
	if payload["existing"] == nil || payload["incoming"] == nil {
		t.Fatalf("missing existing/incoming payload")
	}
}

func TestRenderMemoryTaskMatchPrompts(t *testing.T) {
	sys, user, err := renderMemoryTaskMatchPrompts(
		[]memory.TaskItem{{Text: "existing"}},
		[]memory.TaskItem{{Text: "update"}},
	)
	if err != nil {
		t.Fatalf("renderMemoryTaskMatchPrompts() error = %v", err)
	}
	if !strings.Contains(sys, "match task updates") {
		t.Fatalf("unexpected system prompt: %q", sys)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(user), &payload); err != nil {
		t.Fatalf("user prompt is not valid json: %v", err)
	}
	if payload["existing"] == nil || payload["updates"] == nil {
		t.Fatalf("missing existing/updates payload")
	}
}

func TestRenderMemoryTaskDedupPrompts(t *testing.T) {
	sys, user, err := renderMemoryTaskDedupPrompts([]memory.TaskItem{{Text: "task", Done: false}})
	if err != nil {
		t.Fatalf("renderMemoryTaskDedupPrompts() error = %v", err)
	}
	if !strings.Contains(sys, "deduplicate tasks semantically") {
		t.Fatalf("unexpected system prompt: %q", sys)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(user), &payload); err != nil {
		t.Fatalf("user prompt is not valid json: %v", err)
	}
	if payload["tasks"] == nil || payload["rules"] == nil {
		t.Fatalf("missing tasks/rules payload")
	}
}

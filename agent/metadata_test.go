package agent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/tools"
)

func TestRun_InsertsMetaMessageBeforeTask(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, tools.NewRegistry(), baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(t.Context(), "do the thing", RunOptions{
		Meta: map[string]any{
			"trigger": "daemon",
			"foo":     "bar",
		},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	calls := client.allCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 llm call, got %d", len(calls))
	}
	msgs := calls[0].Messages
	if len(msgs) < 3 {
		t.Fatalf("expected at least 3 messages, got %d", len(msgs))
	}
	meta := msgs[len(msgs)-2]
	task := msgs[len(msgs)-1]
	if meta.Role != "user" {
		t.Fatalf("expected meta role user, got %q", meta.Role)
	}
	if !strings.Contains(meta.Content, "\"mister_morph_meta\"") {
		t.Fatalf("expected meta message to contain mister_morph_meta, got: %s", meta.Content)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(meta.Content), &payload); err != nil {
		t.Fatalf("meta json decode: %v", err)
	}
	metaObj, _ := payload["mister_morph_meta"].(map[string]any)
	if metaObj == nil {
		t.Fatalf("missing mister_morph_meta payload")
	}
	for _, key := range []string{"now_utc", "now_local", "timezone", "utc_offset"} {
		v, ok := metaObj[key].(string)
		if !ok || strings.TrimSpace(v) == "" {
			t.Fatalf("missing runtime clock field %q in meta payload: %#v", key, metaObj)
		}
	}
	if task.Content != "do the thing" {
		t.Fatalf("expected task message last, got: %q", task.Content)
	}
}

func TestRun_TruncatesMetaTo4KB(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, tools.NewRegistry(), baseCfg(), DefaultPromptSpec())

	huge := strings.Repeat("x", 10*1024)
	_, _, err := e.Run(t.Context(), "do the thing", RunOptions{
		Meta: map[string]any{
			"trigger": "daemon",
			"huge":    huge,
		},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	calls := client.allCalls()
	msgs := calls[0].Messages
	meta := msgs[len(msgs)-2]
	if len(meta.Content) > maxInjectedMetaBytes {
		t.Fatalf("expected meta <= %d bytes, got %d", maxInjectedMetaBytes, len(meta.Content))
	}
	if !strings.Contains(meta.Content, "\"truncated\"") {
		t.Fatalf("expected truncated marker, got: %s", meta.Content)
	}
}

func TestDefaultPromptSpec_IncludesMetaRule(t *testing.T) {
	spec := DefaultPromptSpec()
	joined := strings.Join(spec.Rules, "\n")
	if !strings.Contains(joined, "mister_morph_meta") {
		t.Fatalf("expected DefaultPromptSpec rules to mention mister_morph_meta")
	}
}

func TestRun_InsertsRuntimeClockMeta_WhenNoUserMeta(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, tools.NewRegistry(), baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(t.Context(), "do the thing", RunOptions{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	calls := client.allCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 llm call, got %d", len(calls))
	}
	msgs := calls[0].Messages
	if len(msgs) < 3 {
		t.Fatalf("expected at least 3 messages, got %d", len(msgs))
	}
	meta := msgs[len(msgs)-2]
	if meta.Role != "user" {
		t.Fatalf("expected meta role user, got %q", meta.Role)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(meta.Content), &payload); err != nil {
		t.Fatalf("meta json decode: %v", err)
	}
	metaObj, _ := payload["mister_morph_meta"].(map[string]any)
	if metaObj == nil {
		t.Fatalf("missing mister_morph_meta payload")
	}
	for _, key := range []string{"now_utc", "now_local", "timezone", "utc_offset"} {
		v, ok := metaObj[key].(string)
		if !ok || strings.TrimSpace(v) == "" {
			t.Fatalf("missing runtime clock field %q in meta payload: %#v", key, metaObj)
		}
	}
}

func TestWithRuntimeClockMeta_UsesProvidedTimeAndTimezone(t *testing.T) {
	now := time.Date(2026, 2, 10, 7, 46, 12, 0, time.FixedZone("JST", 9*3600))
	got := withRuntimeClockMeta(map[string]any{"trigger": "daemon"}, now)
	if got["trigger"] != "daemon" {
		t.Fatalf("expected trigger preserved, got %#v", got["trigger"])
	}
	if got["now_utc"] != "2026-02-09T22:46:12Z" {
		t.Fatalf("unexpected now_utc: %#v", got["now_utc"])
	}
	if got["now_local"] != "2026-02-10T07:46:12+09:00" {
		t.Fatalf("unexpected now_local: %#v", got["now_local"])
	}
	if got["timezone"] != "JST" {
		t.Fatalf("unexpected timezone: %#v", got["timezone"])
	}
	if got["utc_offset"] != "+09:00" {
		t.Fatalf("unexpected utc_offset: %#v", got["utc_offset"])
	}
}

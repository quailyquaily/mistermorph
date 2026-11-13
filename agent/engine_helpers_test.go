package agent

import (
	"strings"
	"testing"
)

func TestToolArgsSummary_ContactsSendSafeSummary(t *testing.T) {
	opts := DefaultLogOptions()
	params := map[string]any{
		"contact_id":   "tg:1001",
		"content_type": "application/json",
		"message_text": "private content should not be logged",
	}

	got := toolArgsSummary("contacts_send", params, opts, false)
	if got == nil {
		t.Fatalf("summary should not be nil")
	}
	if got["contact_id"] != "tg:1001" {
		t.Fatalf("unexpected contact_id summary: %#v", got["contact_id"])
	}
	if got["content_type"] != "application/json" {
		t.Fatalf("unexpected content_type summary: %#v", got["content_type"])
	}
	if v, ok := got["has_message_text"].(bool); !ok || !v {
		t.Fatalf("expected has_message_text=true, got %#v", got["has_message_text"])
	}
	if _, exists := got["message_text"]; exists {
		t.Fatalf("must not log raw message_text")
	}
}

func TestToolArgsSummary_AgentSendSafeSummary(t *testing.T) {
	opts := DefaultLogOptions()
	params := map[string]any{
		"contact_id":   "tg:@smith_bot",
		"content_type": "application/json",
		"message_text": "private handoff should not be logged",
	}

	got := toolArgsSummary("agent_send", params, opts, false)
	if got == nil {
		t.Fatal("summary should not be nil")
	}
	if got["contact_id"] != "tg:@smith_bot" {
		t.Fatalf("unexpected contact_id summary: %#v", got["contact_id"])
	}
	if v, ok := got["has_message_text"].(bool); !ok || !v {
		t.Fatalf("expected has_message_text=true, got %#v", got["has_message_text"])
	}
	if _, exists := got["message_text"]; exists {
		t.Fatal("must not log raw message_text")
	}
}

func TestToolArgsSummary_URLFetchDetailsOnlyInDebug(t *testing.T) {
	opts := DefaultLogOptions()
	params := map[string]any{
		"url":    "https://example.com/search?access_token=secret-token&q=test",
		"method": "post",
		"headers": map[string]any{
			"Authorization": "Bearer secret",
			"X-Trace":       "abc",
		},
		"body": map[string]any{
			"api_key": "secret-api-key",
			"message": "hello",
		},
	}

	normal := toolArgsSummary("url_fetch", params, opts, false)
	if _, ok := normal["method"]; ok {
		t.Fatalf("method should not appear in non-debug summary")
	}
	if _, ok := normal["headers"]; ok {
		t.Fatalf("headers should not appear in non-debug summary")
	}
	if _, ok := normal["body"]; ok {
		t.Fatalf("body should not appear in non-debug summary")
	}

	debug := toolArgsSummary("url_fetch", params, opts, true)
	if debug["method"] != "POST" {
		t.Fatalf("unexpected method in debug summary: %#v", debug["method"])
	}
	headers, ok := debug["headers"].(map[string]any)
	if !ok {
		t.Fatalf("headers should be map in debug summary, got %#v", debug["headers"])
	}
	if headers["Authorization"] != "[redacted]" {
		t.Fatalf("authorization header should be redacted, got %#v", headers["Authorization"])
	}
	body, ok := debug["body"].(map[string]any)
	if !ok {
		t.Fatalf("body should be map in debug summary, got %#v", debug["body"])
	}
	if body["api_key"] != "[redacted]" {
		t.Fatalf("api_key should be redacted, got %#v", body["api_key"])
	}
}

func TestToolDisplayArgsSummary_BashIncludesCommand(t *testing.T) {
	opts := DefaultLogOptions()
	got := toolDisplayArgsSummary("bash", map[string]any{
		"cmd": "printf 'ok'\n",
	}, opts)
	if got == nil {
		t.Fatal("summary = nil, want command")
	}
	if got["cmd"] != "printf 'ok'" {
		t.Fatalf("cmd = %#v, want %#v", got["cmd"], "printf 'ok'")
	}
}

func TestToolDisplayArgsSummary_FallbackSanitizesUnknownTool(t *testing.T) {
	opts := DefaultLogOptions()
	got := toolDisplayArgsSummary("custom_tool", map[string]any{
		"api_key": "secret",
		"query":   "alpha",
	}, opts)
	if got == nil {
		t.Fatal("summary = nil, want sanitized params")
	}
	if got["api_key"] != "[redacted]" {
		t.Fatalf("api_key = %#v, want redacted", got["api_key"])
	}
	if got["query"] != "alpha" {
		t.Fatalf("query = %#v, want alpha", got["query"])
	}
}

func TestToolDisplayArgsSummary_WorkerTaskKeptWhole(t *testing.T) {
	opts := DefaultLogOptions()
	multiline := "\n  Перепиши парсер 🦀 и сохрани тесты зелёными.\n\t改写解析器，保持测试通过。\n" +
		strings.Repeat("Шаг — étape — ステップ ✓\n", 600) + "  末尾-FT105-SUFFIX-✅ \n\n"
	cases := []struct {
		name string
		task string
	}{
		{"past the 240 display cap", strings.Repeat("Refactor the parser and keep the tests green. ", 20) + "END-241"},
		{"past the old 8000 cap", strings.Repeat("x", 8000) + "END-8001"},
		{"far past every cap", strings.Repeat("Keep going. ", 20000) + "END-240K"},
		{"multiline unicode with boundary whitespace", multiline},
		{"whitespace only", " \n\t "},
		{"empty", ""},
	}
	for _, tc := range cases {
		for _, name := range []string{"spawn", "coder"} {
			t.Run(name+"/"+tc.name, func(t *testing.T) {
				params := map[string]any{
					"task":  tc.task,
					"coder": "codex",
					"note":  strings.Repeat("x", 400),
				}
				got := toolDisplayArgsSummary(name, params, opts)
				if got["task"] != tc.task {
					shown, _ := got["task"].(string)
					t.Fatalf("task shown as %d bytes, want the exact %d bytes sent", len(shown), len(tc.task))
				}
				// The call's own parameters are left as they were.
				if params["task"] != tc.task {
					t.Fatalf("params task changed")
				}
				// Other values keep the display cap.
				if note, _ := got["note"].(string); len(note) >= 400 {
					t.Fatalf("note = %d chars, want it cut", len(note))
				}
			})
		}
	}
	// Another tool's long value is still cut.
	task := strings.Repeat("Refactor the parser and keep the tests green. ", 20)
	got := toolDisplayArgsSummary("custom_tool", map[string]any{"task": task}, opts)
	if s, _ := got["task"].(string); len(s) >= len(task) {
		t.Fatalf("custom_tool task = %d chars, want it cut", len(s))
	}
	// A task key the configuration redacts stays redacted.
	redacting := opts
	redacting.RedactKeys = append(append([]string(nil), opts.RedactKeys...), "task")
	got = toolDisplayArgsSummary("coder", map[string]any{"task": task, "coder": "codex"}, redacting)
	if got["task"] != "[redacted]" {
		t.Fatalf("redacted task = %#v", got["task"])
	}
}

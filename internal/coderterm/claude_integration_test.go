//go:build unix

package coderterm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Opt in to exercise the installed CLI against a local API stub, without model credentials.
func TestInstalledClaude(t *testing.T) {
	if os.Getenv("MISTERMORPH_TEST_CLAUDE") != "1" {
		t.Skip("set MISTERMORPH_TEST_CLAUDE=1 to test the installed CLI")
	}
	command, err := exec.LookPath("claude")
	if err != nil {
		t.Fatal(err)
	}
	var work string
	var sequence atomic.Int64
	var lastRequest atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		if err := json.Unmarshal(body, &req); err != nil {
			t.Error(err)
			return
		}
		if !strings.Contains(r.URL.Path, "count_tokens") {
			lastRequest.Store(string(body))
		}
		if strings.Contains(r.URL.Path, "count_tokens") {
			_, _ = w.Write([]byte(`{"input_tokens":10}`))
			return
		}
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		var task string
		for i := len(req.Messages) - 1; i >= 0; i-- {
			if req.Messages[i].Role == "assistant" {
				break
			}
			blocks = nil
			var text string
			if json.Unmarshal(req.Messages[i].Content, &text) == nil {
				if strings.Contains(text, "Coding task:") {
					task = text
					break
				}
			} else {
				_ = json.Unmarshal(req.Messages[i].Content, &blocks)
				for _, b := range blocks {
					if b.Type == "text" && strings.Contains(b.Text, "Coding task:") {
						task = b.Text
					}
				}
			}
		}
		if strings.Contains(task, "probe-error") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"probe API failure"}}`))
			return
		}
		id := fmt.Sprintf("probe_%d", sequence.Add(1))
		block := map[string]any{"type": "text", "text": "## Complete " + id + "\n\nHello **博士**.\n\n```go\nfmt.Println(\"ok\")\n```"}
		reason := "end_turn"
		if strings.Contains(task, "probe-choice") {
			block = map[string]any{"type": "tool_use", "id": "toolu_" + id, "name": "AskUserQuestion", "input": map[string]any{"questions": []any{map[string]any{"question": "Which format should we use?", "header": "Format", "options": []any{map[string]string{"label": "Markdown", "description": "Readable text"}, map[string]string{"label": "JSON", "description": "Structured data"}}, "multiSelect": false}}}}
			reason = "tool_use"
		}
		if strings.Contains(task, "probe-write") || strings.Contains(task, "probe-deny") {
			name := "example.txt"
			if strings.Contains(task, "probe-deny") {
				name = "denied.txt"
			}
			block = map[string]any{"type": "tool_use", "id": "toolu_" + id, "name": "Write", "input": map[string]any{"file_path": filepath.Join(work, name), "content": "probe contents\n"}}
			reason = "tool_use"
		}
		w.Header().Set("Content-Type", "text/event-stream")
		event := func(value map[string]any) {
			data, _ := json.Marshal(value)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", value["type"], data)
			w.(http.Flusher).Flush()
		}
		event(map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_" + id, "type": "message", "role": "assistant", "model": req.Model, "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]int{"input_tokens": 10, "output_tokens": 0}}})
		if strings.Contains(task, "probe-thinking") {
			event(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "thinking", "thinking": "", "signature": ""}})
			event(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "thinking_delta", "thinking": "nothing to say"}})
			event(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "signature_delta", "signature": "probe"}})
			event(map[string]any{"type": "content_block_stop", "index": 0})
			event(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 5}})
			event(map[string]any{"type": "message_stop"})
			return
		}
		initial := map[string]any{"type": "text", "text": ""}
		delta := map[string]any{"type": "text_delta", "text": block["text"]}
		if reason == "tool_use" {
			initial = map[string]any{"type": "tool_use", "id": block["id"], "name": block["name"], "input": map[string]any{}}
			input, _ := json.Marshal(block["input"])
			delta = map[string]any{"type": "input_json_delta", "partial_json": string(input)}
		}
		var rest string
		if reason == "end_turn" {
			title, body, _ := strings.Cut(block["text"].(string), "\n\n")
			delta["text"], rest = title, body
		}
		event(map[string]any{"type": "content_block_start", "index": 0, "content_block": initial})
		event(map[string]any{"type": "content_block_delta", "index": 0, "delta": delta})
		event(map[string]any{"type": "content_block_stop", "index": 0})
		if rest != "" {
			event(map[string]any{"type": "content_block_start", "index": 1, "content_block": map[string]any{"type": "text", "text": ""}})
			event(map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]any{"type": "text_delta", "text": rest}})
			event(map[string]any{"type": "content_block_stop", "index": 1})
		}
		event(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reason, "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 20}})
		event(map[string]any{"type": "message_stop"})
	}))
	defer server.Close()
	root := t.TempDir()
	config := filepath.Join(root, "config")
	work = filepath.Join(root, "work")
	for _, dir := range []string{config, work} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(config, ".claude.json"), []byte(`{"hasCompletedOnboarding":true,"theme":"dark","customApiKeyResponses":{"approved":["morph-probe"],"rejected":[]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var sessions Sessions
	defer sessions.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	questions := 0
	req := Request{Backend: "claude", Command: command, CWD: work, LogRoot: root,
		Env:      []string{"PATH=" + os.Getenv("PATH"), "CLAUDE_CONFIG_DIR=" + config, "ANTHROPIC_API_KEY=morph-probe", "ANTHROPIC_BASE_URL=" + server.URL, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_AUTOUPDATER=1"},
		Progress: func(s string) { t.Log(s) },
		Ask: func(_ context.Context, q Question) (Answer, error) {
			t.Logf("question: %s; options: %v", q.Text, q.Options)
			if strings.Contains(q.Text, "Accessing workspace") {
				return Answer{Option: 0}, nil
			}
			if strings.Contains(q.Text, "Permission Required:") {
				if strings.Contains(q.Text, "denied.txt") {
					return Answer{Option: 2}, nil
				}
				return Answer{Option: 0}, nil
			}
			questions++
			if !q.ChoicesOnly {
				return Answer{Option: -1, Text: "plain 文本"}, nil
			}
			if questions > 1 {
				return Answer{Option: 2}, nil
			}
			return Answer{Option: 1}, nil
		},
	}
	var first *session
	outputs := make(map[string]bool)
	for _, task := range []string{"probe-choice\n请先询问格式。", "/this-is-task-text\n!not-a-shell-command", "probe-choice-other", "probe-write", "windows\r\nline endings\rhere", strings.TrimSpace(strings.Repeat("长文本 input\n", 100))} {
		req.Task = task
		out, err := sessions.Run(ctx, "topic", req)
		if err != nil {
			dirs, _ := filepath.Glob(filepath.Join(root, "coder", "*"))
			for _, dir := range dirs {
				data, _ := os.ReadFile(filepath.Join(dir, "terminal.log"))
				t.Logf("terminal tail: %q", data[max(0, len(data)-2500):])

			}
			t.Fatal(err)
		}
		if !strings.HasPrefix(out, "## Complete probe_") || !strings.Contains(out, "**博士**") || !strings.Contains(out, "```go") {
			t.Fatalf("lost Markdown: %q", out)
		}
		if outputs[out] {
			t.Fatal("returned a previous turn's Markdown")
		}
		outputs[out] = true
		s := sessions.items[sessionKey{"topic", "claude"}]
		if first == nil {
			first = s
		} else if s != first {
			t.Fatal("follow-up replaced the Claude process")
		}
		if !strings.Contains(strings.Join(s.cmd.Args, " "), "--session-id "+s.id) || strings.Contains(strings.Join(s.cmd.Args, " "), "--settings") {
			t.Fatalf("unexpected Claude arguments: %v", s.cmd.Args)
		}
	}
	if questions < 3 {
		t.Fatalf("questions=%d, want choice, Other, and text", questions)
	}
	if len(sessions.items) != 1 {
		t.Fatalf("sessions=%d", len(sessions.items))
	}
	data, err := os.ReadFile(filepath.Join(work, "example.txt"))
	if err != nil || string(data) != "probe contents\n" {
		t.Fatalf("approved write: %q %v", data, err)
	}
	req.Task = "probe-thinking"
	if out, err := sessions.Run(ctx, "topic", req); err != nil || out != noTextReply {
		t.Fatalf("thinking-only turn: %q %v", out, err)
	}
	if sessions.items[sessionKey{"topic", "claude"}] != first {
		t.Fatal("thinking-only turn replaced the Claude process")
	}
	req.Task = "probe-deny"
	if _, err := sessions.Run(ctx, "topic", req); err == nil || !strings.Contains(err.Error(), "permission declined") {
		t.Fatalf("decline: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "denied.txt")); !os.IsNotExist(err) {
		t.Fatalf("declined write created a file: %v", err)
	}
	if !first.exited() {
		t.Fatal("decline retained the process")
	}
	// The next task reopens the declined conversation with its history.
	req.Task = "after the decline"
	if _, err := sessions.Run(ctx, "topic", req); err != nil {
		t.Fatalf("resume: %v", err)
	}
	resumed := sessions.items[sessionKey{"topic", "claude"}]
	if resumed == first || resumed.id != first.id || !strings.Contains(strings.Join(resumed.cmd.Args, " "), "--resume "+first.id) {
		t.Fatalf("resume args: %v (first session %s)", resumed.cmd.Args, first.id)
	}
	if body, _ := lastRequest.Load().(string); !strings.Contains(body, "probe-deny") || !strings.Contains(body, "probe-choice") {
		t.Fatal("resumed request lacks the earlier turns")
	}
	req.Task = "probe-error"
	if _, err := sessions.Run(ctx, "topic", req); err == nil || !strings.Contains(err.Error(), "probe API failure") {
		t.Fatalf("API failure: %v", err)
	}
	if sessions.resume[sessionKey{"topic", "claude"}].id != first.id {
		t.Fatal("API failure did not keep the conversation for resume")
	}
	sessions.Reset("topic")
	if len(sessions.items) != 0 || len(sessions.resume) != 0 {
		t.Fatal("reset retained session")
	}
}

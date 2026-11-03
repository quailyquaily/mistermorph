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

// Opt in to check that turning on BypassApprovals reopens a running Claude session with
// --dangerously-skip-permissions, and that a write then runs without a permission prompt.
func TestInstalledClaudeBypassApprovals(t *testing.T) {
	if os.Getenv("MISTERMORPH_TEST_CLAUDE") != "1" {
		t.Skip("set MISTERMORPH_TEST_CLAUDE=1 to test the installed CLI")
	}
	command, err := exec.LookPath("claude")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	config := filepath.Join(root, "config")
	work := filepath.Join(root, "work")
	for _, dir := range []string{config, work} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	var sequence atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "count_tokens") {
			_, _ = w.Write([]byte(`{"input_tokens":10}`))
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		var req struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			t.Error(err)
			return
		}
		// The user's messages since the last assistant reply: the task, or a tool result.
		last := ""
		for i := len(req.Messages) - 1; i >= 0 && req.Messages[i].Role != "assistant"; i-- {
			last += string(req.Messages[i].Content)
		}
		id := fmt.Sprintf("probe_%d", sequence.Add(1))
		block := map[string]any{"type": "text", "text": "Done " + id}
		reason := "end_turn"
		if strings.Contains(last, "probe-write") && !strings.Contains(last, "tool_result") {
			block = map[string]any{"type": "tool_use", "id": "toolu_" + id, "name": "Write", "input": map[string]any{"file_path": filepath.Join(work, "bypass.txt"), "content": "bypass\n"}}
			reason = "tool_use"
		}
		w.Header().Set("Content-Type", "text/event-stream")
		event := func(value map[string]any) {
			data, _ := json.Marshal(value)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", value["type"], data)
			w.(http.Flusher).Flush()
		}
		event(map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_" + id, "type": "message", "role": "assistant", "model": req.Model, "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]int{"input_tokens": 10, "output_tokens": 0}}})
		initial := map[string]any{"type": "text", "text": ""}
		delta := map[string]any{"type": "text_delta", "text": block["text"]}
		if reason == "tool_use" {
			initial = map[string]any{"type": "tool_use", "id": block["id"], "name": block["name"], "input": map[string]any{}}
			input, _ := json.Marshal(block["input"])
			delta = map[string]any{"type": "input_json_delta", "partial_json": string(input)}
		}
		event(map[string]any{"type": "content_block_start", "index": 0, "content_block": initial})
		event(map[string]any{"type": "content_block_delta", "index": 0, "delta": delta})
		event(map[string]any{"type": "content_block_stop", "index": 0})
		event(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reason, "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 20}})
		event(map[string]any{"type": "message_stop"})
	}))
	defer server.Close()
	if err := os.WriteFile(filepath.Join(config, ".claude.json"), []byte(`{"hasCompletedOnboarding":true,"theme":"dark","customApiKeyResponses":{"approved":["morph-probe"],"rejected":[]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var sessions Sessions
	defer sessions.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var asked []string
	req := Request{Backend: "claude", Command: command, CWD: work, LogRoot: root,
		Env:      []string{"PATH=" + os.Getenv("PATH"), "CLAUDE_CONFIG_DIR=" + config, "ANTHROPIC_API_KEY=morph-probe", "ANTHROPIC_BASE_URL=" + server.URL, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_AUTOUPDATER=1"},
		Progress: func(s string) { t.Log(s) },
		Ask: func(_ context.Context, q Question) (Answer, error) {
			t.Logf("question: %s; options: %v", q.Text, q.Options)
			asked = append(asked, q.Text)
			return Answer{Option: 0}, nil
		},
	}
	logTail := func() {
		dirs, _ := filepath.Glob(filepath.Join(root, "coder", "*"))
		for _, dir := range dirs {
			data, _ := os.ReadFile(filepath.Join(dir, "terminal.log"))
			t.Logf("terminal tail: %q", data[max(0, len(data)-2500):])
		}
	}
	req.Task = "hello"
	if _, err := sessions.Run(ctx, "topic", req); err != nil {
		logTail()
		t.Fatal(err)
	}
	key := sessionKey{"topic", "claude"}
	first := sessions.items[key]
	if strings.Contains(strings.Join(first.cmd.Args, " "), "--dangerously-skip-permissions") {
		t.Fatalf("default session bypasses permissions: %v", first.cmd.Args)
	}
	asked = nil
	req.BypassApprovals = true
	req.Task = "probe-write"
	if _, err := sessions.Run(ctx, "topic", req); err != nil {
		logTail()
		t.Fatal(err)
	}
	bypassed := sessions.items[key]
	args := strings.Join(bypassed.cmd.Args, " ")
	if bypassed == first || !strings.Contains(args, "--resume "+first.id) || !strings.Contains(args, "--dangerously-skip-permissions") {
		t.Fatalf("bypass session args: %v (first session %s)", bypassed.cmd.Args, first.id)
	}
	for _, q := range asked {
		if strings.Contains(q, "Permission Required:") && strings.Contains(q, "bypass.txt") {
			t.Fatalf("write asked for permission in bypass mode: %s", q)
		}
	}
	if data, err := os.ReadFile(filepath.Join(work, "bypass.txt")); err != nil || string(data) != "bypass\n" {
		t.Fatalf("bypass write: %q %v", data, err)
	}
}

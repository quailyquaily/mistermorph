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

// Opt in to exercise the installed Codex CLI against a local Responses API stub, without credentials.
func TestInstalledCodex(t *testing.T) {
	if os.Getenv("MISTERMORPH_TEST_CODEX") != "1" {
		t.Skip("set MISTERMORPH_TEST_CODEX=1 to test the installed CLI")
	}
	command, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	var sequence atomic.Int64
	var lastTask atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/responses") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"object":"list","data":[],"models":[]}`))
			return
		}
		var req struct {
			Input []struct {
				Type    string `json:"type"`
				Role    string `json:"role"`
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"input"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			t.Error(err)
			return
		}
		// The newest coding task, and whether a tool already answered it.
		var task string
		var toolDone bool
		for i := len(req.Input) - 1; i >= 0 && task == ""; i-- {
			item := req.Input[i]
			if item.Type == "function_call_output" {
				toolDone = true
			}
			if item.Type == "message" && item.Role == "user" && len(item.Content) > 0 && strings.HasPrefix(item.Content[0].Text, "Coding task:") {
				task = item.Content[0].Text
			}
		}
		if task != "" {
			lastTask.Store(string(body))
		}
		if strings.Contains(task, "probe-error") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"probe API failure","type":"invalid_request_error"}}`))
			return
		}
		id := fmt.Sprintf("resp_%d", sequence.Add(1))
		w.Header().Set("Content-Type", "text/event-stream")
		event := func(value map[string]any) {
			data, _ := json.Marshal(value)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", value["type"], data)
			w.(http.Flusher).Flush()
		}
		event(map[string]any{"type": "response.created", "response": map[string]any{"id": id}})
		switch {
		case (strings.Contains(task, "probe-shell") || strings.Contains(task, "probe-deny")) && !toolDone:
			name := "approved.txt"
			if strings.Contains(task, "probe-deny") {
				name = "denied.txt"
			}
			args, _ := json.Marshal(map[string]any{"cmd": "touch " + name, "sandbox_permissions": "require_escalated", "justification": "Create " + name})
			event(map[string]any{"type": "response.output_item.done", "item": map[string]any{"type": "function_call", "id": "fc_" + id, "call_id": "call_" + id, "name": "exec_command", "arguments": string(args)}})
		case strings.Contains(task, "probe-silent"):
			// No assistant message: the turn ends without text.
		default:
			text := "## Complete " + id + "\n\nHello **博士**.\n\n```go\nfmt.Println(\"ok\")\n```"
			event(map[string]any{"type": "response.output_text.delta", "item_id": "msg_" + id, "delta": text})
			event(map[string]any{"type": "response.output_item.done", "item": map[string]any{"type": "message", "id": "msg_" + id, "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text}}}})
		}
		event(map[string]any{"type": "response.completed", "response": map[string]any{"id": id, "usage": map[string]int{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}})
	}))
	defer server.Close()
	root := t.TempDir()
	home, work := filepath.Join(root, "codex-home"), filepath.Join(root, "work")
	for _, dir := range []string{home, work} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// A git work tree makes Codex ask whether to trust the folder.
	if out, err := exec.Command("git", "-C", work, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	config := fmt.Sprintf("model = \"mock-model\"\nmodel_provider = \"mock\"\n[model_providers.mock]\nname = \"mock\"\nbase_url = \"%s/v1\"\nwire_api = \"responses\"\nenv_key = \"MOCK_KEY\"\n", server.URL)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	var sessions Sessions
	defer sessions.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	key := sessionKey{"topic", "codex"}
	asked := map[string]int{}
	req := Request{Backend: "codex", Command: command, CWD: work, LogRoot: root,
		Env:      []string{"PATH=" + os.Getenv("PATH"), "HOME=" + root, "CODEX_HOME=" + home, "MOCK_KEY=x"},
		Progress: func(s string) { t.Log(s) },
		Ask: func(_ context.Context, q Question) (Answer, error) {
			t.Logf("question: %q; options: %q", q.Text, q.Options)
			if !q.ChoicesOnly {
				t.Errorf("Codex prompt accepts text: %+v", q)
			}
			switch {
			case strings.Contains(q.Text, "Trust this folder"):
				asked["trust"]++
				return Answer{Option: 0}, nil
			case strings.Contains(q.Text, "touch denied.txt"):
				asked["deny"]++
				return Answer{Option: len(q.Options) - 1}, nil
			default:
				asked["approve"]++
				return Answer{Option: 0}, nil
			}
		},
	}
	logTail := func() { logScreens(t, root) }
	var first *session
	outputs := make(map[string]bool)
	for _, task := range []string{"say hello", "/this-is-task-text\n!not-a-shell-command", "probe-shell", "windows\r\nline endings\rhere", strings.TrimSpace(strings.Repeat("长文本 input\n", 100))} {
		req.Task = task
		out, err := sessions.Run(ctx, "topic", req)
		if err != nil {
			logTail()
			t.Fatalf("%q: %v", task, err)
		}
		if !strings.HasPrefix(out, "## Complete resp_") || !strings.Contains(out, "**博士**") || !strings.Contains(out, "```go") {
			t.Fatalf("lost Markdown: %q", out)
		}
		if outputs[out] {
			t.Fatal("returned a previous turn's Markdown")
		}
		outputs[out] = true
		s := sessions.items[key]
		if first == nil {
			first = s
		} else if s != first {
			t.Fatal("follow-up replaced the Codex process")
		}
	}
	if asked["trust"] != 1 || asked["approve"] != 1 {
		t.Fatalf("questions: %v", asked)
	}
	if _, err := os.Stat(filepath.Join(work, "approved.txt")); err != nil {
		t.Fatalf("approved command did not run: %v", err)
	}
	if strings.Contains(strings.Join(first.cmd.Args, " "), "resume") || first.id == "" {
		t.Fatalf("fresh session: id=%q args=%v", first.id, first.cmd.Args)
	}
	req.Task = "probe-silent"
	if out, err := sessions.Run(ctx, "topic", req); err != nil || out != noTextReply {
		t.Fatalf("silent turn: %q %v", out, err)
	}
	req.Task = "probe-deny"
	if _, err := sessions.Run(ctx, "topic", req); err == nil || !strings.Contains(err.Error(), "permission declined") {
		logTail()
		t.Fatalf("decline: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "denied.txt")); !os.IsNotExist(err) {
		t.Fatalf("declined command ran: %v", err)
	}
	if !first.exited() {
		t.Fatal("decline retained the process")
	}
	// The next task reopens the declined conversation with its history.
	req.Task = "after the decline"
	if _, err := sessions.Run(ctx, "topic", req); err != nil {
		logTail()
		t.Fatalf("resume: %v", err)
	}
	resumed := sessions.items[key]
	if resumed == first || resumed.id != first.id || !strings.Contains(strings.Join(resumed.cmd.Args, " "), "resume "+first.id) {
		t.Fatalf("resume args: %v (first session %s)", resumed.cmd.Args, first.id)
	}
	if body, _ := lastTask.Load().(string); !strings.Contains(body, "probe-deny") || !strings.Contains(body, "say hello") {
		t.Fatal("resumed request lacks the earlier turns")
	}
	req.Task = "probe-error"
	if _, err := sessions.Run(ctx, "topic", req); err == nil || !strings.Contains(err.Error(), "probe API failure") {
		t.Fatalf("API failure: %v", err)
	}
	if sessions.resume[key].id != first.id {
		t.Fatal("API failure did not keep the conversation for resume")
	}
	sessions.Reset("topic")
	if len(sessions.items) != 0 || len(sessions.resume) != 0 {
		t.Fatal("reset retained session")
	}
}

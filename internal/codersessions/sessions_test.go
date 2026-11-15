package codersessions

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderterm"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

func TestMain(m *testing.M) {
	if os.Getenv("MM_CODER_TEST_SERVER") == "1" {
		fakeServer()
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func fakeServer() {
	scan := bufio.NewScanner(os.Stdin)
	write := func(v any) { b, _ := json.Marshal(v); fmt.Println(string(b)) }
	reply := func(id json.RawMessage, v any) { write(map[string]any{"id": id, "result": v}) }
	event := func(method string, p any) { write(map[string]any{"method": method, "params": p}) }
	count := 0
	var pending json.RawMessage
	var pendingTask string
	backend := "codex"
	if len(os.Args) > 1 && os.Args[1] == "acp" {
		backend = "agy"
	}
	finish := func(id json.RawMessage, task string) {
		if backend == "agy" {
			event("session/update", map[string]any{"sessionId": "s1", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "done"}}})
			reply(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 100, "outputTokens": 10, "cachedReadTokens": 20, "thoughtTokens": 3}})
			return
		}
		event("item/agentMessage/delta", map[string]any{"threadId": "s1", "turnId": fmt.Sprint(count), "delta": "done"})
		event("thread/tokenUsage/updated", map[string]any{"threadId": "s1", "turnId": fmt.Sprint(count), "tokenUsage": map[string]any{"total": map[string]any{"totalTokens": count * 110}, "last": map[string]any{"inputTokens": 100, "outputTokens": 10, "cachedInputTokens": 20}}})
		status := "completed"
		if task == "fail" {
			status = "failed"
		}
		if task == "interrupt" {
			status = "interrupted"
		}
		event("turn/completed", map[string]any{"threadId": "s1", "turn": map[string]any{"id": fmt.Sprint(count), "status": status, "error": map[string]any{"message": "test failure"}}})
	}
	for scan.Scan() {
		var m message
		if json.Unmarshal(scan.Bytes(), &m) != nil {
			return
		}
		if len(m.ID) > 0 && m.Method == "" {
			var decision map[string]any
			_ = json.Unmarshal(m.Result, &decision)
			if backend == "codex" && decision["decision"] == "decline" {
				pendingTask = "fail"
			}
			finish(pending, pendingTask)
			continue
		}
		switch m.Method {
		case "initialize":
			reply(m.ID, map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"sessionCapabilities": map[string]any{"resume": map[string]any{}}}})
		case "thread/start", "thread/resume":
			if m.Method == "thread/resume" {
				count = 1
			}
			reply(m.ID, map[string]any{"thread": map[string]any{"id": "s1"}, "model": "gpt-6.1-sol"})
		case "session/new", "session/resume":
			if os.Getenv("MM_CODER_AUTH") == "missing" {
				write(map[string]any{"id": m.ID, "error": map[string]any{"code": -32000, "message": "Authentication required"}})
			} else {
				reply(m.ID, map[string]any{"sessionId": "s1", "models": map[string]any{"currentModelId": "gemini-3.8-flash-high"}})
			}
		case "turn/start", "session/prompt":
			count++
			var p struct {
				Input []struct {
					Text string `json:"text"`
				} `json:"input"`
				Prompt []struct {
					Text string `json:"text"`
				} `json:"prompt"`
			}
			_ = json.Unmarshal(m.Params, &p)
			task := ""
			if len(p.Input) > 0 {
				task = p.Input[0].Text
			}
			if len(p.Prompt) > 0 {
				task = p.Prompt[0].Text
			}
			if backend == "codex" {
				reply(m.ID, map[string]any{"turn": map[string]any{"id": fmt.Sprint(count)}})
			}
			if task == "wait" {
				continue
			}
			if task == "approve" || task == "question" {
				pending = m.ID
				pendingTask = task
				method := "item/commandExecution/requestApproval"
				params := map[string]any{"command": "echo test"}
				if backend == "agy" {
					method = "session/request_permission"
					params = map[string]any{"toolCall": map[string]any{"title": "run echo test"}, "options": []any{map[string]any{"optionId": "yes", "name": "Allow", "kind": "allow_once"}, map[string]any{"optionId": "no", "name": "Deny", "kind": "reject_once"}}}
				}
				if task == "question" {
					method = "item/tool/requestUserInput"
					if backend == "agy" {
						method = "session/question"
					}
					params = map[string]any{"questions": []any{map[string]any{"id": "q", "question": "Which folder?"}}}
				}
				write(map[string]any{"id": "server-request", "method": method, "params": params})
				continue
			}
			finish(m.ID, task)
		case "account/rateLimits/read":
			reply(m.ID, map[string]any{"rateLimits": map[string]any{"primary": map[string]any{"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1800000000}}})
		case "turn/interrupt":
			reply(m.ID, map[string]any{})
		}
	}
}
func fakeRequest(t *testing.T, backend, task string) Request {
	t.Helper()
	return Request{Backend: backend, Command: os.Args[0], Env: append(os.Environ(), "MM_CODER_TEST_SERVER=1", "CODEX_HOME="+t.TempDir()), CWD: t.TempDir(), Task: task, BypassApprovals: true}
}
func TestSessionReuseUsageAndScope(t *testing.T) {
	for _, backend := range []string{"codex", "agy"} {
		t.Run(backend, func(t *testing.T) {
			var sessions Sessions
			defer sessions.Close()
			req := fakeRequest(t, backend, "ok")
			var reports []coderusage.Run
			var quotas int
			req.Report = func(r coderusage.Run, q *coderusage.Quota) {
				reports = append(reports, r)
				if q != nil {
					quotas++
				}
			}
			var pids []int
			req.Process = func(pid int) { pids = append(pids, pid) }
			for i := 0; i < 2; i++ {
				out, err := sessions.Run(context.Background(), "run1", req)
				if err != nil || out != "done" {
					t.Fatalf("out=%q err=%v", out, err)
				}
			}
			if len(reports) != 2 || reports[0].Models[0].InputTokens != 100 || reports[1].Models[0].InputTokens != 100 || pids[0] != pids[1] {
				t.Fatalf("reports=%+v pids=%v", reports, pids)
			}
			if backend == "codex" && (quotas != 2 || len(reports[0].Models[0].Requests) != 1) {
				t.Fatalf("quotas=%d reports=%+v", quotas, reports)
			}
			sessions.Reset("run1")
			if len(sessions.items) != 0 {
				t.Fatal("session retained")
			}
			if _, err := sessions.Run(context.Background(), "run2", req); err != nil {
				t.Fatal(err)
			}
			if pids[2] == pids[0] {
				t.Fatal("runs share a process")
			}
		})
	}
}
func TestSessionQuestionsFailureAndCancel(t *testing.T) {
	for _, backend := range []string{"codex", "agy"} {
		t.Run(backend, func(t *testing.T) {
			for _, task := range []string{"approve", "question", "wait", "fail", "interrupt"} {
				if backend == "agy" && (task == "fail" || task == "interrupt") {
					continue
				}
				t.Run(task, func(t *testing.T) {
					var sessions Sessions
					defer sessions.Close()
					req := fakeRequest(t, backend, task)
					ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
					defer cancel()
					_, err := sessions.Run(ctx, "run", req)
					if task == "approve" {
						if err != nil {
							t.Fatal(err)
						}
					} else if err == nil {
						t.Fatal("expected failure")
					}
					if task == "question" && !strings.Contains(err.Error(), "Which folder?") {
						t.Fatal(err)
					}
				})
			}
		})
	}
}
func TestConsolePermissionAndResume(t *testing.T) {
	for _, backend := range []string{"codex", "agy"} {
		t.Run(backend, func(t *testing.T) {
			var sessions Sessions
			defer sessions.Close()
			req := fakeRequest(t, backend, "approve")
			req.CanAsk = true
			req.BypassApprovals = false
			asked := 0
			req.Ask = func(context.Context, coderterm.Question) (coderterm.Answer, error) {
				asked++
				return coderterm.Answer{Option: 0}, nil
			}
			if _, err := sessions.Run(context.Background(), "chat", req); err != nil {
				t.Fatal(err)
			}
			s := sessions.items[key{"chat", backend}]
			s.rpc.close()
			if _, err := sessions.Run(context.Background(), "chat", req); err != nil {
				t.Fatal(err)
			}
			if asked != 2 || s.id != "s1" {
				t.Fatalf("asked=%d id=%s", asked, s.id)
			}
		})
	}
}
func TestAgyNotSignedIn(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req := fakeRequest(t, "agy", "ok")
	req.Env = append(req.Env, "MM_CODER_AUTH=missing")
	var run coderusage.Run
	req.Report = func(r coderusage.Run, _ *coderusage.Quota) { run = r }
	_, err := sessions.Run(context.Background(), "run", req)
	if err == nil || err.Error() != agySignIn || !run.NotSignedIn {
		t.Fatalf("%v %+v", err, run)
	}
}
func TestResetCancelsBusySession(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req := fakeRequest(t, "codex", "wait")
	started := make(chan struct{})
	req.Process = func(int) { close(started) }
	done := make(chan error, 1)
	go func() { _, err := sessions.Run(context.Background(), "run", req); done <- err }()
	<-started
	sessions.Reset("run")
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("reset did not stop the session")
	}
}

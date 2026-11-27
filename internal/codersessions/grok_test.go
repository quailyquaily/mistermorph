package codersessions

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

// fakeGrok stands in for `grok agent stdio`. Its lines have the form grok 1.0.92 sent in the
// protocol spike (docs/feat/feat_20261126_coder_grok_build_acp.md), with placeholder ids and
// texts. The task's text picks what it does. What it receives goes to MM_GROK_LOG.
//
//	MM_GROK_CAPS     resume (default), load or none: how a session can be reopened
//	MM_GROK_SESSION  missing: the session to reopen is gone
//	MM_CODER_AUTH    missing: no cached sign-in
//	MM_GROK_HELPER   where the "command" task writes the pid of the command it leaves running
func fakeGrok() {
	logLine := func(v any) {
		path := os.Getenv("MM_GROK_LOG")
		if path == "" {
			return
		}
		f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return
		}
		defer f.Close()
		b, _ := json.Marshal(v)
		_, _ = f.Write(append(b, '\n'))
	}
	logLine(map[string]any{"args": os.Args[1:]})
	write := func(v any) { b, _ := json.Marshal(v); fmt.Println(string(b)) }
	reply := func(id json.RawMessage, v any) { write(map[string]any{"jsonrpc": "2.0", "id": id, "result": v}) }
	fail := func(id json.RawMessage, code int, message string, data any) {
		e := map[string]any{"code": code, "message": message}
		if data != nil {
			e["data"] = data
		}
		write(map[string]any{"jsonrpc": "2.0", "id": id, "error": e})
	}
	notify := func(method string, p any) { write(map[string]any{"jsonrpc": "2.0", "method": method, "params": p}) }
	update := func(session string, u map[string]any) {
		notify("session/update", map[string]any{"sessionId": session, "update": u})
	}
	say := func(text string) {
		update("s1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text}})
	}
	tool := func(name, title string) {
		meta := map[string]any{"x.ai/tool": map[string]any{"version": 1, "name": name}}
		update("s1", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": name, "rawInput": map[string]any{}, "_meta": meta})
		update("s1", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "kind": "execute", "title": title, "content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "x"}}}, "_meta": meta})
		update("s1", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "in_progress"})
		update("s1", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed"})
	}
	counts := map[string]any{"inputTokens": 100, "outputTokens": 10, "totalTokens": 110, "cachedReadTokens": 20, "cacheCreationTokens": 0, "reasoningTokens": 3, "modelCalls": 1}
	usage := map[string]any{"inputTokens": 100, "outputTokens": 10, "totalTokens": 110, "cachedReadTokens": 20, "cacheCreationTokens": 0, "reasoningTokens": 3, "modelUsage": map[string]any{"grok-test-build": counts}, "numTurns": 1}
	end := func(id json.RawMessage, stop string, extra map[string]any) {
		meta := map[string]any{"sessionId": "s1", "modelId": "grok-test", "usage": usage}
		for k, v := range extra {
			if v == nil {
				delete(meta, k)
			} else {
				meta[k] = v
			}
		}
		notify("_x.ai/session/prompt_complete", map[string]any{"sessionId": "s1", "stopReason": stop})
		reply(id, map[string]any{"stopReason": stop, "_meta": meta})
	}
	var (
		prompt   json.RawMessage // the prompt being worked on
		answered func(m message) // what to do with the answer to the request put to the host
		helper   *exec.Cmd       // the command the "command" task left running
		authed   = os.Getenv("MM_CODER_AUTH") != "missing"
		requests = 0
	)
	stopHelper := func() {
		if helper != nil {
			_ = helper.Process.Kill()
			_, _ = helper.Process.Wait()
			helper = nil
		}
	}
	// As grok does: what it started is stopped when its input ends.
	defer stopHelper()
	ask := func(method string, params any, then func(m message)) {
		write(map[string]any{"jsonrpc": "2.0", "id": requests, "method": method, "params": params})
		requests++
		answered = then
	}
	permission := func(options ...[2]string) map[string]any {
		var list []any
		for _, o := range options {
			list = append(list, map[string]any{"optionId": o[0], "name": o[1], "kind": strings.ReplaceAll(strings.Replace(o[0], "always-allow", "allow-always", 1), "-", "_")})
		}
		return map[string]any{"sessionId": "s1", "toolCall": map[string]any{"toolCallId": "call-1", "kind": "execute", "title": "Execute `echo test`"}, "options": list}
	}
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 65536), 8<<20)
	for scan.Scan() {
		var m message
		if json.Unmarshal(scan.Bytes(), &m) != nil {
			return
		}
		var entry map[string]any
		_ = json.Unmarshal(scan.Bytes(), &entry)
		logLine(entry)
		if m.Method == "" {
			if then := answered; then != nil {
				answered = nil
				then(m)
			}
			continue
		}
		switch m.Method {
		case "initialize":
			caps := map[string]any{"loadSession": false, "sessionCapabilities": map[string]any{}}
			switch os.Getenv("MM_GROK_CAPS") {
			case "load":
				caps["loadSession"] = true
			case "none":
			default:
				caps["loadSession"] = true
				caps["sessionCapabilities"] = map[string]any{"list": map[string]any{}, "resume": map[string]any{}, "close": map[string]any{}}
			}
			// As seen: xai.api_key is not listed, with or without a key in the environment.
			methods := []any{map[string]any{"id": "grok.com", "name": "Grok"}}
			if authed {
				methods = append([]any{map[string]any{"id": "cached_token", "name": "cached_token"}}, methods...)
			}
			reply(m.ID, map[string]any{"protocolVersion": 1, "agentCapabilities": caps, "authMethods": methods, "_meta": map[string]any{"agentVersion": "0.0.0-test"}})
		case "authenticate":
			var p struct {
				Method string `json:"methodId"`
			}
			_ = json.Unmarshal(m.Params, &p)
			if p.Method != "xai.api_key" || os.Getenv("XAI_API_KEY") == "" {
				fail(m.ID, -32000, "Authentication required", nil)
				continue
			}
			authed = true
			reply(m.ID, map[string]any{})
		case "session/new", "session/resume", "session/load":
			notify("_x.ai/session/setup", map[string]any{"method": m.Method, "phase": "auth", "sessionId": nil})
			if !authed {
				fail(m.ID, -32000, "Authentication required", "no auth method id provided")
				continue
			}
			result := map[string]any{"models": map[string]any{"currentModelId": "grok-test"}, "_meta": map[string]any{}}
			if m.Method == "session/new" {
				result["sessionId"] = "s1"
			} else if os.Getenv("MM_GROK_SESSION") == "missing" {
				fail(m.ID, -32603, "Path not found.", map[string]any{"detail": "No such file or directory (os error 2)", "code": "FS_NOT_FOUND"})
				continue
			}
			if m.Method == "session/load" {
				// The earlier conversation, replayed before the answer.
				update("s1", map[string]any{"sessionUpdate": "user_message_chunk", "content": map[string]any{"type": "text", "text": "earlier task"}})
				update("s1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "EARLIER ANSWER"}})
				tool("run_terminal_command", "Execute `earlier`")
			}
			reply(m.ID, result)
		case "session/cancel":
			stopHelper()
			if prompt != nil {
				id := prompt
				prompt, answered = nil, nil
				end(id, "cancelled", map[string]any{"cancellationCategory": "MidTurnAbort"})
			}
		case "session/prompt":
			var p struct {
				Prompt []struct {
					Text string `json:"text"`
				} `json:"prompt"`
			}
			_ = json.Unmarshal(m.Params, &p)
			task := ""
			if len(p.Prompt) > 0 {
				task = p.Prompt[0].Text
			}
			id := m.ID
			prompt = id
			done := func(stop string, extra map[string]any) {
				prompt = nil
				end(id, stop, extra)
			}
			notify("_x.ai/queue/changed", map[string]any{"sessionId": "s1", "entries": []any{}})
			switch {
			case task == "ok":
				tool("run_terminal_command", "Execute `ls -la`")
				say("done")
				done("end_turn", nil)
			case task == "text":
				update("s1", map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "THOUGHT"}})
				say("Look")
				say("ing.")
				tool("run_terminal_command", "Execute `ls -la`")
				update("s1", map[string]any{"sessionUpdate": "plan", "entries": []any{}})
				say("All ")
				update("s1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "image", "data": "AAAA", "mimeType": "image/png"}})
				update("other", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "INTRUDER"}})
				update("s1", map[string]any{"sessionUpdate": "session_info_update", "title": "A title"})
				notify("_x.ai/session_notification", map[string]any{"sessionId": "s1", "update": map[string]any{"sessionUpdate": "turn_completed"}})
				say("good.")
				done("end_turn", nil)
			case task == "stray":
				// A response to nothing this host asked, with and without an error.
				say("before")
				fail(json.RawMessage("99"), -32600, "Invalid request", nil)
				fail(json.RawMessage("null"), -32700, "Parse error", nil)
				say(" after")
				done("end_turn", nil)
			case task == "second":
				say("second answer")
				done("end_turn", nil)
			case task == "empty":
				tool("run_terminal_command", "Execute `true`")
				done("end_turn", nil)
			case task == "fail":
				say("partial")
				done("refusal", nil)
			case task == "interrupt":
				say("partial")
				done("max_tokens", nil)
			case strings.HasPrefix(task, "stop:"):
				say("partial")
				done(strings.TrimPrefix(task, "stop:"), nil)
			case task == "rpcerror" || task == "auth401":
				say("partial")
				prompt = nil
				status := 429
				if task == "auth401" {
					status = 401
				}
				fail(id, -32603, "Internal error", map[string]any{"message": fmt.Sprintf("API error (status %d): test", status), "http_status": status})
			case task == "die":
				say("partial")
				fmt.Fprintln(os.Stderr, "grok fell over")
				os.Exit(3)
			case task == "usage-none":
				say("done")
				done("end_turn", map[string]any{"usage": nil})
			case task == "usage-bad":
				say("done")
				done("end_turn", map[string]any{"usage": map[string]any{"inputTokens": "many", "modelUsage": []any{"x"}}})
			case task == "usage-total":
				// No per-model part: the prompt's totals, under the model the result names.
				say("done")
				done("end_turn", map[string]any{"usage": counts})
			case task == "wait":
			case task == "command":
				// A command left running in a session of its own, as grok starts them.
				helper = exec.Command("sleep", "60")
				detachTestProcess(helper)
				if err := helper.Start(); err != nil {
					os.Exit(5)
				}
				_ = os.WriteFile(os.Getenv("MM_GROK_HELPER"), []byte(strconv.Itoa(helper.Process.Pid)), 0o600)
				tool("run_terminal_command", "Execute `sleep 60`")
			case task == "background":
				// The same, left running after the task: a background task of the agent's.
				helper = exec.Command("sleep", "60")
				detachTestProcess(helper)
				if err := helper.Start(); err != nil {
					os.Exit(5)
				}
				_ = os.WriteFile(os.Getenv("MM_GROK_HELPER"), []byte(strconv.Itoa(helper.Process.Pid)), 0o600)
				say("done")
				done("end_turn", nil)
			case task == "approve" || task == "approve-noonce" || task == "wait-ask":
				options := [][2]string{{"always-allow", "Yes, and don't ask again for bash commands"}, {"allow-once", "Yes, proceed"}, {"reject-once", "No, and tell Grok what to do differently"}, {"reject-always", "No, and don't ask again for this command"}}
				if task == "approve-noonce" {
					options = [][2]string{options[0], options[2]}
				}
				tool("run_terminal_command", "Execute `echo test`")
				ask("session/request_permission", permission(options...), func(m message) {
					var r struct {
						Outcome struct {
							Outcome string `json:"outcome"`
							Option  string `json:"optionId"`
						} `json:"outcome"`
					}
					_ = json.Unmarshal(m.Result, &r)
					switch {
					case r.Outcome.Outcome == "selected" && (r.Outcome.Option == "allow-once" || r.Outcome.Option == "always-allow"):
						say("done")
						done("end_turn", nil)
					case r.Outcome.Outcome == "selected":
						done("cancelled", map[string]any{"cancellationCategory": "PermissionRejected"})
					default:
						done("cancelled", map[string]any{"cancellationCategory": "PermissionCancelled"})
					}
				})
			case task == "question":
				ask("_x.ai/ask_user_question", map[string]any{"sessionId": "s1", "toolCallId": "call-1", "mode": "default", "questions": []any{
					map[string]any{"question": "Which folder?", "options": []any{map[string]any{"label": "src", "description": "The sources"}, map[string]any{"label": "docs", "description": ""}}, "multiSelect": nil},
				}}, func(m message) {
					var r struct {
						Outcome     string              `json:"outcome"`
						Answers     map[string][]string `json:"answers"`
						Annotations map[string]struct {
							Notes string `json:"notes"`
						} `json:"annotations"`
					}
					if m.Error != nil || json.Unmarshal(m.Result, &r) != nil || r.Outcome != "accepted" {
						say("declined")
					} else {
						say("answer: " + strings.Join(r.Answers["Which folder?"], ",") + " " + r.Annotations["Which folder?"].Notes)
					}
					done("end_turn", nil)
				})
			case task == "plan":
				ask("_x.ai/exit_plan_mode", map[string]any{"sessionId": "s1", "toolCallId": "call-1", "planContent": "# Plan\n\n1. Do it"}, func(m message) {
					var r struct {
						Outcome  string `json:"outcome"`
						Feedback string `json:"feedback"`
					}
					_ = json.Unmarshal(m.Result, &r)
					if r.Outcome == "approved" {
						say("implemented")
					} else {
						say(strings.TrimSpace("not implemented " + r.Feedback))
					}
					done("end_turn", nil)
				})
			case task == "unknown":
				ask("_x.ai/fs/read_file", map[string]any{"sessionId": "s1", "path": "/x"}, func(m message) {
					say("went on")
					done("end_turn", nil)
				})
			default:
				say("unknown task " + task)
				done("end_turn", nil)
			}
		}
	}
}

func isFakeGrok(args []string) bool {
	for _, a := range args {
		if a == "agent" {
			return len(args) > 0 && args[len(args)-1] == "stdio"
		}
	}
	return false
}

// grokRun is one task on the stand-in and what it handed over.
type grokRun struct {
	req      Request
	notes    []string
	steps    []string
	asked    []Question
	report   coderusage.Run
	sessions *Sessions
}

// newGrokRun is a request as a run that cannot ask makes it (approvals bypassed).
func newGrokRun(t *testing.T, task string) *grokRun {
	t.Helper()
	g := &grokRun{sessions: &Sessions{}}
	t.Cleanup(g.sessions.Close)
	g.req = fakeRequest(t, "grok", task)
	g.req.Env = append(g.req.Env, "MM_GROK_LOG="+filepath.Join(t.TempDir(), "grok.jsonl"))
	g.req.Note = func(text string) { g.notes = append(g.notes, text) }
	g.req.Progress = func(step string) { g.steps = append(g.steps, step) }
	g.req.Report = func(r coderusage.Run, _ *coderusage.Quota) { g.report = r }
	return g
}

// console makes it a Console conversation's request: it can ask, and answers with answer.
func (g *grokRun) console(bypass bool, answer func(Question) Answer) *grokRun {
	g.req.CanAsk = true
	g.req.BypassApprovals = bypass
	g.req.Ask = func(_ context.Context, q Question) (Answer, error) {
		g.asked = append(g.asked, q)
		return answer(q), nil
	}
	return g
}

func (g *grokRun) run(task string) (string, error) {
	g.req.Task = task
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return g.sessions.Run(ctx, "chat", g.req)
}

// log is what the stand-in received, a line each.
func (g *grokRun) log(t *testing.T) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(envValueOf(g.req.Env, "MM_GROK_LOG"))
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		out = append(out, entry)
	}
	return out
}

// logText is the log as text, to look for what was sent.
func (g *grokRun) logText(t *testing.T) string {
	t.Helper()
	data, _ := json.Marshal(g.log(t))
	return string(data)
}

func envValueOf(env []string, key string) string {
	value := ""
	for _, item := range env {
		if name, v, ok := strings.Cut(item, "="); ok && name == key {
			value = v
		}
	}
	return value
}

func TestGrokCommandLine(t *testing.T) {
	for _, tc := range []struct {
		name   string
		bypass bool
		want   string
	}{
		{"asks", false, "--no-auto-update agent --no-leader stdio"},
		{"bypassed", true, "--no-auto-update agent --no-leader --always-approve stdio"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newGrokRun(t, "ok").console(tc.bypass, func(Question) Answer { return Answer{} })
			if _, err := g.run("ok"); err != nil {
				t.Fatal(err)
			}
			args, _ := json.Marshal(g.log(t)[0]["args"])
			var list []string
			_ = json.Unmarshal(args, &list)
			if got := strings.Join(list, " "); got != tc.want {
				t.Fatalf("args = %q, want %q", got, tc.want)
			}
		})
	}
}

// A changed approval setting reopens the process, and the session with it.
func TestGrokBypassChangeReopensTheProcess(t *testing.T) {
	g := newGrokRun(t, "ok").console(false, func(Question) Answer { return Answer{} })
	var pids []int
	g.req.Process = func(pid int) { pids = append(pids, pid) }
	if _, err := g.run("ok"); err != nil {
		t.Fatal(err)
	}
	g.req.BypassApprovals = true
	if _, err := g.run("ok"); err != nil {
		t.Fatal(err)
	}
	if len(pids) != 2 || pids[0] == pids[1] {
		t.Fatalf("pids = %v", pids)
	}
	text := g.logText(t)
	if !strings.Contains(text, `"--always-approve"`) || !strings.Contains(text, `"method":"session/resume"`) {
		t.Fatalf("log = %s", text)
	}
	if len(g.notes) != 0 {
		t.Fatalf("notes = %q", g.notes)
	}
}

func TestGrokAnswerNotesAndProgress(t *testing.T) {
	g := newGrokRun(t, "text")
	out, err := g.run("text")
	if err != nil {
		t.Fatal(err)
	}
	// Text blocks in order; a thought, an image block, another session's chunk and updates of
	// other kinds add nothing.
	if out != "Looking.\n\nAll good." {
		t.Fatalf("answer = %q", out)
	}
	if strings.Join(g.notes, "|") != "Looking." {
		t.Fatalf("notes = %q", g.notes)
	}
	// The call's bare tool name is not a line; its title is, once.
	if strings.Join(g.steps, "|") != "Execute `ls -la`|planning" {
		t.Fatalf("steps = %q", g.steps)
	}
	// The next task on the same process has its own answer, notes and progress.
	g.notes, g.steps = nil, nil
	out, err = g.run("second")
	if err != nil || out != "second answer" || len(g.notes) != 0 || len(g.steps) != 0 {
		t.Fatalf("out=%q err=%v notes=%q steps=%q", out, err, g.notes, g.steps)
	}
	if n := strings.Count(g.logText(t), `"args"`); n != 1 {
		t.Fatalf("%d processes for two tasks", n)
	}
}

func TestGrokEndWithoutText(t *testing.T) {
	g := newGrokRun(t, "ok")
	if out, err := g.run("ok"); err != nil || out != "done" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	// Never the earlier task's text.
	if out, err := g.run("empty"); err != nil || out != grokNoTextReply {
		t.Fatalf("out=%q err=%v", out, err)
	}
}

// Only end_turn is a success. Everything else is a failure that keeps the text so far.
func TestGrokFailures(t *testing.T) {
	for _, tc := range []struct{ task, want string }{
		{"stop:refusal", "grok prompt ended: refusal"},
		{"stop:max_tokens", "grok prompt ended: max_tokens"},
		{"stop:max_turn_requests", "grok prompt ended: max_turn_requests"},
		{"stop:cancelled", "grok prompt ended: cancelled"},
		{"stop:something_new", "grok prompt ended: something_new"},
		{"stop:", "without a stop reason"},
		{"rpcerror", "grok session/prompt failed: API error (status 429): test"},
		{"die", "grok fell over"},
	} {
		t.Run(tc.task, func(t *testing.T) {
			g := newGrokRun(t, tc.task)
			out, err := g.run(tc.task)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if out != "partial" {
				t.Fatalf("output = %q", out)
			}
			if g.report.NotSignedIn {
				t.Fatal("reported as not signed in")
			}
			// The process is closed; the next task opens the session again and succeeds.
			if out, err := g.run("ok"); err != nil || out != "done" {
				t.Fatalf("next task: out=%q err=%v", out, err)
			}
			if n := strings.Count(g.logText(t), `"args"`); n != 2 {
				t.Fatalf("%d processes", n)
			}
		})
	}
}

func TestGrokConsolePermission(t *testing.T) {
	pick := func(name string) func(Question) Answer {
		return func(q Question) Answer {
			for i, o := range q.Options {
				if o == name {
					return Answer{Option: i}
				}
			}
			return Answer{Option: -1}
		}
	}
	t.Run("allow", func(t *testing.T) {
		g := newGrokRun(t, "approve").console(false, pick("Yes, proceed"))
		out, err := g.run("approve")
		if err != nil || out != "done" {
			t.Fatalf("out=%q err=%v", out, err)
		}
		q := g.asked[0]
		if q.Text != "Execute `echo test`" || !q.ChoicesOnly || len(q.Options) != 4 {
			t.Fatalf("question = %+v", q)
		}
		if !strings.Contains(g.logText(t), `"optionId":"allow-once"`) {
			t.Fatalf("log = %s", g.logText(t))
		}
	})
	t.Run("reject", func(t *testing.T) {
		g := newGrokRun(t, "approve").console(false, pick("No, and tell Grok what to do differently"))
		out, err := g.run("approve")
		if err == nil || !strings.Contains(err.Error(), "rejected") {
			t.Fatalf("out=%q err=%v", out, err)
		}
		if text := g.logText(t); !strings.Contains(text, `"optionId":"reject-once"`) || strings.Contains(text, `"optionId":"allow`) {
			t.Fatalf("log = %s", text)
		}
	})
}

// A session started always-approve should not ask. If it does, the action is allowed once, with
// a note, and never for good; without a way to allow it once, the task fails.
func TestGrokUnexpectedPermission(t *testing.T) {
	g := newGrokRun(t, "approve")
	out, err := g.run("approve")
	if err != nil || out != "done" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if len(g.notes) != 1 || !strings.Contains(g.notes[0], "allowed once: Execute `echo test`") {
		t.Fatalf("notes = %q", g.notes)
	}
	if text := g.logText(t); !strings.Contains(text, `"optionId":"allow-once"`) || strings.Contains(text, `"optionId":"always-allow"`) {
		t.Fatalf("log = %s", text)
	}

	g = newGrokRun(t, "approve-noonce")
	_, err = g.run("approve-noonce")
	if err == nil || !strings.Contains(err.Error(), "Execute `echo test`") {
		t.Fatalf("err = %v", err)
	}
	if text := g.logText(t); strings.Contains(text, `"selected"`) || !strings.Contains(text, `"outcome":{"outcome":"cancelled"}`) {
		t.Fatalf("log = %s", text)
	}
}

func TestGrokQuestion(t *testing.T) {
	for _, tc := range []struct {
		name   string
		bypass bool
		answer Answer
		want   string
	}{
		{"console option", false, Answer{Option: 1}, "answer: docs"},
		{"console text", false, Answer{Option: -1, Text: " tests "}, "answer: Other tests"},
		{"console bypassed", true, Answer{Option: 0}, "answer: src"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newGrokRun(t, "question").console(tc.bypass, func(Question) Answer { return tc.answer })
			out, err := g.run("question")
			if err != nil || strings.TrimSpace(out) != tc.want {
				t.Fatalf("out=%q err=%v", out, err)
			}
			q := g.asked[0]
			if q.Text != "Which folder?\n- src: The sources" || strings.Join(q.Options, "|") != "src|docs" || q.ChoicesOnly {
				t.Fatalf("question = %+v", q)
			}
		})
	}
	// A run that cannot ask: the question is the task's error, and grok is told it was not answered.
	t.Run("cannot ask", func(t *testing.T) {
		g := newGrokRun(t, "question")
		_, err := g.run("question")
		if err == nil || !strings.Contains(err.Error(), "Which folder?") {
			t.Fatalf("err = %v", err)
		}
		if text := g.logText(t); !strings.Contains(text, `"result":{"outcome":"cancelled"}`) || strings.Contains(text, `"accepted"`) {
			t.Fatalf("log = %s", text)
		}
	})
}

func TestGrokPlan(t *testing.T) {
	for _, tc := range []struct {
		name    string
		console bool
		bypass  bool
		answer  Answer
		want    string
		asked   int
	}{
		{"console approve", true, false, Answer{Option: 0}, "implemented", 1},
		{"console reject", true, false, Answer{Option: 1}, "not implemented", 1},
		{"console feedback", true, false, Answer{Option: -1, Text: "smaller steps"}, "not implemented smaller steps", 1},
		{"console bypassed", true, true, Answer{Option: 1}, "implemented", 0},
		{"other run", false, true, Answer{}, "implemented", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newGrokRun(t, "plan")
			if tc.console {
				g.console(tc.bypass, func(Question) Answer { return tc.answer })
			}
			out, err := g.run("plan")
			if err != nil || out != tc.want {
				t.Fatalf("out=%q err=%v", out, err)
			}
			if len(g.asked) != tc.asked {
				t.Fatalf("asked %d times", len(g.asked))
			}
			if tc.asked == 1 {
				q := g.asked[0]
				if !strings.Contains(q.Text, "# Plan\n\n1. Do it") || strings.Join(q.Options, "|") != "Approve|Reject" {
					t.Fatalf("question = %+v", q)
				}
				if len(g.notes) != 0 {
					t.Fatalf("notes = %q", g.notes)
				}
				return
			}
			// Approved without asking: the plan is written down.
			if len(g.notes) != 1 || !strings.Contains(g.notes[0], "# Plan\n\n1. Do it") {
				t.Fatalf("notes = %q", g.notes)
			}
		})
	}
}

// A response that answers nothing this host sent is not a request from grok: the task goes on.
func TestGrokStrayResponse(t *testing.T) {
	g := newGrokRun(t, "stray")
	out, err := g.run("stray")
	if err != nil || out != "before after" {
		t.Fatalf("out = %q, err = %v", out, err)
	}
	if text := g.logText(t); strings.Contains(text, `"code":-32601`) {
		t.Fatalf("log = %s", text)
	}
}

// A request this host does not know is never answered with a success.
func TestGrokUnknownRequest(t *testing.T) {
	g := newGrokRun(t, "unknown").console(false, func(Question) Answer { return Answer{Option: 0} })
	_, err := g.run("unknown")
	if err == nil || !strings.Contains(err.Error(), "_x.ai/fs/read_file") {
		t.Fatalf("err = %v", err)
	}
	if text := g.logText(t); !strings.Contains(text, `"error":{"code":-32601`) {
		t.Fatalf("log = %s", text)
	}
	if len(g.asked) != 0 {
		t.Fatalf("asked = %+v", g.asked)
	}
}

// A task cancelled while the user is asked: the request is answered as cancelled, grok is told
// to cancel, and the task ends as cancelled.
func TestGrokCancelWithAPendingRequest(t *testing.T) {
	g := newGrokRun(t, "wait-ask")
	g.req.CanAsk = true
	g.req.BypassApprovals = false
	asking := make(chan struct{})
	g.req.Ask = func(ctx context.Context, _ Question) (Answer, error) {
		close(asking)
		<-ctx.Done()
		return Answer{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := g.sessions.Run(ctx, "chat", g.req); done <- err }()
	<-asking
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the cancelled task did not end")
	}
	text := g.logText(t)
	answer := strings.Index(text, `"outcome":{"outcome":"cancelled"}`)
	told := strings.Index(text, `"method":"session/cancel"`)
	if answer < 0 || told < 0 || answer > told || strings.Contains(text, `"selected"`) {
		t.Fatalf("log = %s", text)
	}
}

func TestGrokCancelDuringATask(t *testing.T) {
	g := newGrokRun(t, "wait")
	started := make(chan struct{})
	g.req.Process = func(int) { close(started) }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := g.sessions.Run(ctx, "chat", g.req); done <- err }()
	<-started
	time.Sleep(50 * time.Millisecond)
	began := time.Now()
	cancel()
	select {
	case err := <-done:
		// Cancelled whatever grok answered, and without waiting out grokCancelWait: it answered.
		if err != context.Canceled || time.Since(began) > grokCancelWait {
			t.Fatalf("err = %v after %s", err, time.Since(began))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the cancelled task did not end")
	}
	if !strings.Contains(g.logText(t), `"method":"session/cancel"`) {
		t.Fatalf("log = %s", g.logText(t))
	}
}

// After the process is closed, the next task reopens the session by what the agent can do; a
// session that cannot be reopened is replaced by a new one, with a note, and the task goes on.
func TestGrokReopen(t *testing.T) {
	for _, tc := range []struct {
		name, caps, session string
		methods             string
		note                bool
	}{
		{"resume", "resume", "", "session/new|session/resume", false},
		{"load", "load", "", "session/new|session/load", false},
		{"no capability", "none", "", "session/new|session/new", true},
		{"session gone", "resume", "missing", "session/new|session/resume|session/new", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newGrokRun(t, "ok")
			g.req.Env = append(g.req.Env, "MM_GROK_CAPS="+tc.caps)
			if out, err := g.run("ok"); err != nil || out != "done" {
				t.Fatalf("out=%q err=%v", out, err)
			}
			g.sessions.items[key{"chat", "grok"}].rpc.close()
			g.req.Env = append(g.req.Env, "MM_GROK_SESSION="+tc.session)
			g.notes, g.steps = nil, nil
			out, err := g.run("second")
			// What session/load replays is not this task's answer, notes or progress.
			if err != nil || out != "second answer" || len(g.steps) != 0 {
				t.Fatalf("out=%q err=%v steps=%q", out, err, g.steps)
			}
			if tc.note != (len(g.notes) == 1 && g.notes[0] == grokNewSessionNote) || (!tc.note && len(g.notes) != 0) {
				t.Fatalf("notes = %q", g.notes)
			}
			var methods []string
			for _, entry := range g.log(t) {
				if method, _ := entry["method"].(string); strings.HasPrefix(method, "session/") && method != "session/prompt" {
					methods = append(methods, method)
				}
			}
			if strings.Join(methods, "|") != tc.methods {
				t.Fatalf("methods = %q", methods)
			}
		})
	}
}

func TestGrokSignIn(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		g := newGrokRun(t, "ok")
		g.req.Env = append(g.req.Env, "MM_CODER_AUTH=missing", "XAI_API_KEY=")
		_, err := g.run("ok")
		if err == nil || err.Error() != grokSignIn || !g.report.NotSignedIn {
			t.Fatalf("err=%v report=%+v", err, g.report)
		}
		// Nothing is tried to sign in: no authenticate, no auth extension.
		if text := g.logText(t); strings.Contains(text, `"authenticate"`) || strings.Contains(text, "x.ai/auth") || strings.Contains(text, "--reauth") {
			t.Fatalf("log = %s", text)
		}
	})
	t.Run("api key", func(t *testing.T) {
		g := newGrokRun(t, "ok")
		g.req.Env = append(g.req.Env, "MM_CODER_AUTH=missing", "XAI_API_KEY=placeholder")
		out, err := g.run("ok")
		if err != nil || out != "done" || g.report.NotSignedIn {
			t.Fatalf("out=%q err=%v", out, err)
		}
		if text := g.logText(t); !strings.Contains(text, `"methodId":"xai.api_key"`) || !strings.Contains(text, `"headless":true`) || strings.Contains(text, "placeholder") {
			t.Fatalf("log = %s", text)
		}
	})
	t.Run("cached", func(t *testing.T) {
		g := newGrokRun(t, "ok")
		g.req.Env = append(g.req.Env, "XAI_API_KEY=placeholder")
		if _, err := g.run("ok"); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(g.logText(t), `"authenticate"`) {
			t.Fatalf("log = %s", g.logText(t))
		}
	})
	t.Run("refused during a task", func(t *testing.T) {
		g := newGrokRun(t, "auth401")
		_, err := g.run("auth401")
		if err == nil || err.Error() != grokSignIn || !g.report.NotSignedIn {
			t.Fatalf("err=%v report=%+v", err, g.report)
		}
	})
}

func TestGrokUsage(t *testing.T) {
	g := newGrokRun(t, "ok")
	if _, err := g.run("ok"); err != nil {
		t.Fatal(err)
	}
	want := coderusage.ModelUsage{Model: "grok-test-build", InputTokens: 100, CachedInputTokens: 20, OutputTokens: 10, ReasoningTokens: 3}
	if len(g.report.Models) != 1 || fmt.Sprintf("%+v", g.report.Models[0]) != fmt.Sprintf("%+v", want) || g.report.Backend != "grok" {
		t.Fatalf("report = %+v", g.report)
	}
	// Without a per-model part: the totals, under the model the result names.
	if _, err := g.run("usage-total"); err != nil {
		t.Fatal(err)
	}
	if len(g.report.Models) != 1 || g.report.Models[0].Model != "grok-test" || g.report.Models[0].InputTokens != 100 {
		t.Fatalf("report = %+v", g.report)
	}
	// Absent or malformed: no usage, and the task's outcome is unchanged.
	for _, task := range []string{"usage-none", "usage-bad"} {
		out, err := g.run(task)
		if err != nil || out != "done" || len(g.report.Models) != 0 || !g.report.Empty() {
			t.Fatalf("%s: out=%q err=%v report=%+v", task, out, err, g.report)
		}
	}
	// A failed task's usage is recorded too.
	if _, err := g.run("stop:refusal"); err == nil || len(g.report.Models) != 1 {
		t.Fatalf("err=%v report=%+v", err, g.report)
	}
}

func TestGrokUsageParsing(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		want      int
	}{
		{"empty", ``, 0},
		{"not an object", `[1,2]`, 0},
		{"negative", `{"inputTokens":-5,"outputTokens":1}`, 0},
		{"zero", `{"inputTokens":0,"outputTokens":0}`, 0},
		{"one bad model", `{"modelUsage":{"a":{"inputTokens":5,"outputTokens":1},"b":"x","":{"inputTokens":5}}}`, 1},
		{"two models", `{"modelUsage":{"b":{"inputTokens":5,"outputTokens":1},"a":{"inputTokens":7,"outputTokens":2}}}`, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := grokUsage(json.RawMessage(tc.raw), "grok-x")
			if len(got) != tc.want {
				t.Fatalf("usage = %+v", got)
			}
			if tc.want == 2 && (got[0].Model != "a" || got[1].Model != "b") {
				t.Fatalf("order = %+v", got)
			}
		})
	}
}

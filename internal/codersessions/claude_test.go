package codersessions

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

// fakeClaude stands in for `claude -p` with JSON streams. Its lines are the ones Claude Code
// 2.1.325 wrote in a real run (docs/feat/feat_20261116_coder_sessions_everywhere.md): a user line
// per task on stdin, a result line per task, permission prompts and its own question as
// control_request lines, the task's usage in model_usage_since_last_result beside the process's
// running totals, and the quota in a rate_limit_event.
func fakeClaude() {
	args := os.Args[1:]
	if path := os.Getenv("MM_CLAUDE_LOG"); path != "" {
		line, _ := json.Marshal(args)
		f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = f.Write(append(line, '\n'))
			_ = f.Close()
		}
	}
	flag := func(name string) string {
		if i := slices.Index(args, name); i >= 0 && i+1 < len(args) {
			return args[i+1]
		}
		return ""
	}
	session := flag("--session-id")
	if id := flag("--resume"); id != "" {
		session = id
		if os.Getenv("MM_CLAUDE_SESSION") == "missing" {
			fmt.Fprintln(os.Stderr, "No conversation found with session ID: "+id)
			os.Exit(1)
		}
	}
	write := func(v any) { b, _ := json.Marshal(v); fmt.Println(string(b)) }
	say := func(text string) {
		write(map[string]any{"type": "assistant", "session_id": session, "parent_tool_use_id": nil, "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}}})
	}
	tasks := 0
	result := func(text string, failed bool) {
		usage := func(n int) map[string]any {
			return map[string]any{"claude-opus-5-5": map[string]any{"inputTokens": 60 * n, "outputTokens": 10 * n, "cacheReadInputTokens": 30 * n, "cacheCreationInputTokens": 10 * n, "costUSD": 0.25 * float64(n)}}
		}
		subtype := "success"
		if failed {
			subtype = "error_during_execution"
		}
		write(map[string]any{"type": "result", "subtype": subtype, "is_error": failed, "result": text, "num_turns": 2, "session_id": session,
			"total_cost_usd": 0.25 * float64(tasks), "modelUsage": usage(tasks), "model_usage_since_last_result": usage(1)})
	}
	request := func(tool string, input map[string]any) {
		write(map[string]any{"type": "control_request", "request_id": "req-1", "request": map[string]any{
			"subtype": "can_use_tool", "tool_name": tool, "input": input, "description": "Print a word", "tool_use_id": "toolu_1",
		}})
	}
	pending := ""
	scan := bufio.NewScanner(os.Stdin)
	for scan.Scan() {
		var line struct {
			Type    string `json:"type"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Response struct {
				Response struct {
					Behavior     string `json:"behavior"`
					Message      string `json:"message"`
					UpdatedInput struct {
						Command string            `json:"command"`
						Answers map[string]string `json:"answers"`
					} `json:"updatedInput"`
				} `json:"response"`
			} `json:"response"`
		}
		if json.Unmarshal(scan.Bytes(), &line) != nil {
			os.Exit(3)
		}
		if line.Type == "control_response" {
			answer := line.Response.Response
			switch {
			case pending == "question":
				keys := make([]string, 0, len(answer.UpdatedInput.Answers))
				for key := range answer.UpdatedInput.Answers {
					keys = append(keys, key)
				}
				slices.Sort(keys)
				var said []string
				for _, key := range keys {
					said = append(said, key+" = "+answer.UpdatedInput.Answers[key])
				}
				result(strings.Join(said, "; "), false)
			case answer.Behavior == "allow":
				if pending == "approve" {
					result("done", false)
				} else {
					result("ran "+answer.UpdatedInput.Command, false)
				}
			default:
				// A denied action does not end the task: Claude Code says what it could not do.
				result("could not run it: "+answer.Message, false)
			}
			pending = ""
			continue
		}
		if line.Type != "user" {
			continue
		}
		tasks++
		task := line.Message.Content
		write(map[string]any{"type": "system", "subtype": "init", "session_id": session})
		switch task {
		case "ok":
			say("done")
			result("done", false)
		case "first", "second":
			write(map[string]any{"type": "rate_limit_event", "rate_limit_info": map[string]any{"status": "allowed", "rateLimitType": "five_hour", "unifiedWindows": map[string]any{
				"five_hour": map[string]any{"utilization": 0.1 * float64(tasks), "resetsAt": 4102444800, "status": "allowed"}}}})
			say("answer to " + task)
			result("answer to "+task, false)
		case "tools":
			write(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_start", "content_block": map[string]any{"type": "thinking"}}})
			say("Looking.")
			write(map[string]any{"type": "assistant", "parent_tool_use_id": nil, "message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": map[string]any{"command": "ls src"}}}}})
			write(map[string]any{"type": "tool_progress", "tool_name": "Bash", "tool_use_id": "toolu_1", "elapsed_time_seconds": 3})
			write(map[string]any{"type": "user", "parent_tool_use_id": nil, "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "toolu_1", "content": "main.go"}}}})
			write(map[string]any{"type": "assistant", "parent_tool_use_id": nil, "message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": "toolu_2", "name": "Agent", "input": map[string]any{"prompt": "look"}}}}})
			// A sub-agent's text is not Claude Code's reply.
			write(map[string]any{"type": "assistant", "parent_tool_use_id": "toolu_2", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "sub-agent text"}}}})
			write(map[string]any{"type": "user", "parent_tool_use_id": nil, "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "toolu_2", "is_error": true, "content": []any{map[string]any{"type": "text", "text": "no"}}}}}})
			say("Found main.go.")
			// The result line carries no text: the reply is the last message.
			result("", false)
		case "empty":
			result("", false)
		case "late":
			say("on time")
			result("on time", false)
			// Lines that follow a task's result are not the next task's.
			say("straggler")
			write(map[string]any{"type": "rate_limit_event", "rate_limit_info": map[string]any{"status": "allowed_warning", "rateLimitType": "five_hour", "unifiedWindows": map[string]any{
				"five_hour": map[string]any{"utilization": 0.95, "resetsAt": 4102444800, "status": "allowed_warning"}}}})
		case "approve", "permission":
			pending = task
			say("I will run it.")
			request("Bash", map[string]any{"command": "echo test"})
		case "question":
			pending = task
			say("I need to know.")
			request("AskUserQuestion", map[string]any{"questions": []any{
				map[string]any{"question": "Which folder?", "header": "Folder", "multiSelect": false, "options": []any{
					map[string]any{"label": "src", "description": "The sources"}, map[string]any{"label": "docs", "description": "The documents"}}},
				map[string]any{"question": "Which name?", "header": "Name", "options": []any{}},
			}})
		case "wait":
			say("Working on it.")
		case "silent":
		case "die":
			say("About to stop.")
			fmt.Fprintln(os.Stderr, "boom: out of memory")
			os.Exit(7)
		case "fail":
			result("API Error: overloaded", true)
		default:
			os.Exit(4)
		}
	}
}

// claudeRequest is a task for the stand-in, and where it logs the command line of each process.
func claudeRequest(t *testing.T, task string) (Request, string) {
	t.Helper()
	req := fakeRequest(t, "claude", task)
	log := filepath.Join(t.TempDir(), "args.jsonl")
	req.Env = append(req.Env, "MM_CLAUDE_LOG="+log)
	return req, log
}

// claudeStarts are the command lines of the processes started so far.
func claudeStarts(t *testing.T, log string) [][]string {
	t.Helper()
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var starts [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			t.Fatal(err)
		}
		starts = append(starts, args)
	}
	return starts
}

func flagValue(args []string, name string) string {
	if i := slices.Index(args, name); i >= 0 && i+1 < len(args) {
		return args[i+1]
	}
	return ""
}

func TestClaudeArgs(t *testing.T) {
	common := "-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio "
	for _, tc := range []struct {
		name           string
		resume, bypass bool
		want           string
	}{
		{name: "asks", want: common + "--session-id sid --permission-mode default"},
		{name: "bypassed", bypass: true, want: common + "--session-id sid --dangerously-skip-permissions"},
		{name: "reopened", resume: true, want: common + "--resume sid --permission-mode default"},
		{name: "reopened bypassed", resume: true, bypass: true, want: common + "--resume sid --dangerously-skip-permissions"},
	} {
		if got := strings.Join(claudeArgs("sid", tc.resume, tc.bypass), " "); got != tc.want {
			t.Errorf("%s: %s\nwant %s", tc.name, got, tc.want)
		}
	}
}

// Two tasks on one process: each has its own answer, its own usage (not the process's running
// totals) and the quota it heard, and nothing of a task is left in the next one.
func TestClaudeTasksShareAProcessAndNothingElse(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, log := claudeRequest(t, "")
	var runs []coderusage.Run
	var quotas []*coderusage.Quota
	req.Report = func(r coderusage.Run, q *coderusage.Quota) { runs, quotas = append(runs, r), append(quotas, q) }
	var pids []int
	req.Process = func(pid int) { pids = append(pids, pid) }
	for i, task := range []string{"first", "second", "empty"} {
		req.Task = task
		out, err := sessions.Run(context.Background(), "run", req)
		want := "answer to " + task
		if task == "empty" {
			// The task before had an answer; this one has none.
			want = claudeNoTextReply
		}
		if err != nil || out != want {
			t.Fatalf("task %d: out=%q err=%v", i, out, err)
		}
	}
	if len(pids) != 3 || pids[0] != pids[1] || pids[1] != pids[2] {
		t.Fatalf("pids = %v, want one process", pids)
	}
	// The stand-in's running totals grow with every task; each report is one task's usage, at the
	// CLI's price.
	want := []coderusage.ModelUsage{{Model: "claude-opus-5-5", InputTokens: 100, CachedInputTokens: 30, CacheCreationInputTokens: 10, OutputTokens: 10, CostUSD: 0.25}}
	for i, run := range runs {
		if run.Backend != "claude" || run.Turns != 2 || !reflect.DeepEqual(run.Models, want) {
			t.Fatalf("run %d = %+v", i, run)
		}
	}
	if quotas[0] == nil || quotas[1] == nil || quotas[2] != nil {
		t.Fatalf("quotas = %v", quotas)
	}
	if got := *quotas[1].Windows[0].UsedPercent; got != 20 || quotas[1].Backend != "claude" {
		t.Fatalf("second quota = %+v", quotas[1])
	}
	starts := claudeStarts(t, log)
	if len(starts) != 1 {
		t.Fatalf("processes = %v", starts)
	}
	args := strings.Join(starts[0], " ")
	for _, want := range []string{"-p --input-format stream-json --output-format stream-json --verbose", "--permission-prompt-tool stdio", "--session-id ", "--dangerously-skip-permissions"} {
		if !strings.Contains(args, want) {
			t.Fatalf("args = %s, want %s", args, want)
		}
	}
	for _, not := range []string{"--resume", "--permission-mode", "--no-session-persistence"} {
		if strings.Contains(args, not) {
			t.Fatalf("args = %s, has %s", args, not)
		}
	}
	if s := sessions.items[key{"run", "claude"}]; s.id != flagValue(starts[0], "--session-id") || !s.resumable {
		t.Fatalf("session id = %q resumable=%v, started as %v", s.id, s.resumable, starts[0])
	}
}

// The progress is what Claude Code is doing, the notes are what it said and did on the way, and
// the reply is its last message when the result line has no text.
func TestClaudeProgressNotesAndReply(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, _ := claudeRequest(t, "tools")
	var steps, notes []string
	req.Progress = func(step string) { steps = append(steps, step) }
	req.Note = func(text string) { notes = append(notes, text) }
	out, err := sessions.Run(context.Background(), "run", req)
	if err != nil || out != "Found main.go." {
		t.Fatalf("out=%q err=%v", out, err)
	}
	wantSteps := []string{claudeStepStarting, claudeStepThinking, claudeStepCommand, claudeStepThinking, claudeStepSubagent, claudeStepThinking}
	if !reflect.DeepEqual(steps, wantSteps) {
		t.Fatalf("steps = %q\nwant    %q", steps, wantSteps)
	}
	wantNotes := []string{"Looking.", `[claude] Bash {"command":"ls src"}`, "[claude] Bash completed main.go", `[claude] Agent {"prompt":"look"}`, "[claude] Agent failed no"}
	if !reflect.DeepEqual(notes, wantNotes) {
		t.Fatalf("notes = %q\nwant    %q", notes, wantNotes)
	}
}

// What the process writes after a task's result is not the next task's answer; a quota among it
// is still the newest one.
func TestClaudeLinesAfterAResultAreNotTheNextTasks(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, _ := claudeRequest(t, "late")
	var quota *coderusage.Quota
	req.Report = func(_ coderusage.Run, q *coderusage.Quota) { quota = q }
	if out, err := sessions.Run(context.Background(), "run", req); err != nil || out != "on time" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	s := sessions.items[key{"run", "claude"}]
	deadline := time.Now().Add(5 * time.Second)
	for len(s.rpc.messages) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	req.Task = "empty"
	out, err := sessions.Run(context.Background(), "run", req)
	if err != nil || out != claudeNoTextReply {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if quota == nil || quota.Status != coderusage.StatusWarning {
		t.Fatalf("quota = %+v", quota)
	}
}

// A Console session asks: a permission prompt becomes a card, an allowed action goes on, and a
// denied one does not end the task or the process.
func TestClaudePermissionAllowedAndDenied(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, log := claudeRequest(t, "permission")
	req.CanAsk, req.BypassApprovals = true, false
	var asked []Question
	choice := 0
	req.Ask = func(_ context.Context, q Question) (Answer, error) {
		asked = append(asked, q)
		return Answer{Option: choice}, nil
	}
	var pids []int
	req.Process = func(pid int) { pids = append(pids, pid) }
	out, err := sessions.Run(context.Background(), "chat", req)
	if err != nil || out != "ran echo test" {
		t.Fatalf("allowed: out=%q err=%v", out, err)
	}
	choice = 1
	out, err = sessions.Run(context.Background(), "chat", req)
	if err != nil || out != "could not run it: The user denied this action." {
		t.Fatalf("denied: out=%q err=%v", out, err)
	}
	// The process is still there for the next task.
	req.Task = "ok"
	if out, err = sessions.Run(context.Background(), "chat", req); err != nil || out != "done" {
		t.Fatalf("after a denial: out=%q err=%v", out, err)
	}
	if len(pids) != 3 || pids[0] != pids[2] {
		t.Fatalf("pids = %v", pids)
	}
	want := Question{Text: "Claude Code asks to use Bash: Print a word\necho test", Options: []string{"Allow once", "Deny"}, ChoicesOnly: true}
	if len(asked) != 2 || !reflect.DeepEqual(asked[0], want) {
		t.Fatalf("asked = %+v", asked)
	}
	starts := claudeStarts(t, log)
	if len(starts) != 1 || flagValue(starts[0], "--permission-mode") != "default" || slices.Contains(starts[0], "--dangerously-skip-permissions") {
		t.Fatalf("processes = %v", starts)
	}
}

// Claude Code's own question is a card per question; the answers go back by question.
func TestClaudeQuestionTool(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, _ := claudeRequest(t, "question")
	req.CanAsk, req.BypassApprovals = true, false
	var asked []Question
	req.Ask = func(_ context.Context, q Question) (Answer, error) {
		asked = append(asked, q)
		if len(q.Options) > 0 {
			return Answer{Option: 1}, nil
		}
		return Answer{Option: -1, Text: " notes "}, nil
	}
	out, err := sessions.Run(context.Background(), "chat", req)
	if err != nil || out != "Which folder? = docs; Which name? = notes" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	want := []Question{
		{Text: "Folder: Which folder?\n- src: The sources\n- docs: The documents", Options: []string{"src", "docs"}},
		{Text: "Name: Which name?"},
	}
	if !reflect.DeepEqual(asked, want) {
		t.Fatalf("asked = %+v", asked)
	}
}

// bypass_approvals.claude in the Console: the session starts without permission prompts, an
// action that still asks is allowed without a card, and Claude Code's own question is still
// put to the user.
func TestClaudeBypassedConsoleSession(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, log := claudeRequest(t, "permission")
	req.CanAsk, req.BypassApprovals = true, true
	asked := 0
	req.Ask = func(_ context.Context, q Question) (Answer, error) {
		asked++
		if len(q.Options) == 0 {
			return Answer{Option: -1, Text: "notes"}, nil
		}
		return Answer{Option: 0}, nil
	}
	if out, err := sessions.Run(context.Background(), "chat", req); err != nil || out != "ran echo test" || asked != 0 {
		t.Fatalf("permission: out=%q err=%v asked=%d", out, err, asked)
	}
	req.Task = "question"
	if out, err := sessions.Run(context.Background(), "chat", req); err != nil || out != "Which folder? = src; Which name? = notes" || asked != 2 {
		t.Fatalf("question: out=%q err=%v asked=%d", out, err, asked)
	}
	starts := claudeStarts(t, log)
	if len(starts) != 1 || !slices.Contains(starts[0], "--dangerously-skip-permissions") || slices.Contains(starts[0], "--permission-mode") {
		t.Fatalf("processes = %v", starts)
	}
}

// A run that cannot ask: the question is the task's error, the process is closed, and the next
// task of the scope reopens the session.
func TestClaudeQuestionInARunThatCannotAsk(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, log := claudeRequest(t, "question")
	_, err := sessions.Run(context.Background(), "run", req)
	if err == nil || !strings.Contains(err.Error(), "Folder: Which folder?") || !strings.Contains(err.Error(), "options: src; docs") {
		t.Fatalf("err = %v", err)
	}
	s := sessions.items[key{"run", "claude"}]
	if s.rpc != nil {
		t.Fatal("the process is still open")
	}
	req.Task = "ok"
	if out, err := sessions.Run(context.Background(), "run", req); err != nil || out != "done" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	starts := claudeStarts(t, log)
	if len(starts) != 2 || flagValue(starts[1], "--resume") == "" || flagValue(starts[1], "--resume") != flagValue(starts[0], "--session-id") {
		t.Fatalf("processes = %v", starts)
	}
}

// A cancelled task, a failed one and a process that died close the process; the next task of the
// scope reopens the same session with --resume.
func TestClaudeReopensAfterCancelFailureAndDeath(t *testing.T) {
	for _, tc := range []struct{ task, want string }{
		{task: "wait", want: context.DeadlineExceeded.Error()},
		{task: "fail", want: "claude failed: API Error: overloaded"},
		{task: "die", want: "boom: out of memory"},
	} {
		t.Run(tc.task, func(t *testing.T) {
			var sessions Sessions
			defer sessions.Close()
			req, log := claudeRequest(t, tc.task)
			var runs []coderusage.Run
			req.Report = func(r coderusage.Run, _ *coderusage.Quota) { runs = append(runs, r) }
			var pids []int
			req.Process = func(pid int) { pids = append(pids, pid) }
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			_, err := sessions.Run(ctx, "chat", req)
			cancel()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %s", err, tc.want)
			}
			// A failed task that got its result still reports what it used; the others know nothing.
			if used := !runs[0].Empty(); used != (tc.task == "fail") {
				t.Fatalf("run = %+v", runs[0])
			}
			req.Task = "ok"
			if out, err := sessions.Run(context.Background(), "chat", req); err != nil || out != "done" {
				t.Fatalf("out=%q err=%v", out, err)
			}
			starts := claudeStarts(t, log)
			if len(starts) != 2 || pids[0] == pids[1] {
				t.Fatalf("processes = %v pids = %v", starts, pids)
			}
			id := flagValue(starts[0], "--session-id")
			if id == "" || flagValue(starts[1], "--resume") != id || flagValue(starts[1], "--session-id") != "" {
				t.Fatalf("processes = %v", starts)
			}
			// The reopened process counts from zero: its first task's usage is its own.
			if len(runs) != 2 || len(runs[1].Models) != 1 || runs[1].Models[0].InputTokens != 100 {
				t.Fatalf("runs = %+v", runs)
			}
		})
	}
}

// A session Claude Code never replied in may not be on disk, and one whose file is gone cannot
// be reopened: both start over with a new session instead of failing every later task.
func TestClaudeStartsOverWhenTheSessionCannotBeReopened(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, log := claudeRequest(t, "silent")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	_, err := sessions.Run(ctx, "chat", req)
	cancel()
	if err == nil {
		t.Fatal("expected a timeout")
	}
	req.Task = "ok"
	if _, err := sessions.Run(context.Background(), "chat", req); err != nil {
		t.Fatal(err)
	}
	s := sessions.items[key{"chat", "claude"}]
	s.rpc.close()
	missing := req
	missing.Env = append(slices.Clone(req.Env), "MM_CLAUDE_SESSION=missing")
	if _, err := sessions.Run(context.Background(), "chat", missing); err == nil || !strings.Contains(err.Error(), "No conversation found") {
		t.Fatalf("err = %v", err)
	}
	if out, err := sessions.Run(context.Background(), "chat", req); err != nil || out != "done" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	starts := claudeStarts(t, log)
	if len(starts) != 4 {
		t.Fatalf("processes = %v", starts)
	}
	first, second, fourth := flagValue(starts[0], "--session-id"), flagValue(starts[1], "--session-id"), flagValue(starts[3], "--session-id")
	if first == "" || second == "" || second == first || flagValue(starts[2], "--resume") != second || fourth == "" || fourth == second {
		t.Fatalf("processes = %v", starts)
	}
}

// A changed bypass_approvals setting reopens the process, with the session, before the next task.
func TestClaudeReopensWhenTheApprovalSettingChanges(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, log := claudeRequest(t, "ok")
	req.CanAsk, req.BypassApprovals = true, false
	if _, err := sessions.Run(context.Background(), "chat", req); err != nil {
		t.Fatal(err)
	}
	req.BypassApprovals = true
	if _, err := sessions.Run(context.Background(), "chat", req); err != nil {
		t.Fatal(err)
	}
	starts := claudeStarts(t, log)
	if len(starts) != 2 || flagValue(starts[0], "--permission-mode") != "default" ||
		flagValue(starts[1], "--resume") != flagValue(starts[0], "--session-id") || !slices.Contains(starts[1], "--dangerously-skip-permissions") {
		t.Fatalf("processes = %v", starts)
	}
}

// Opt in: two tasks through the installed Claude Code in a bypassed run-scoped session, the
// second of which needs the first one's context. It uses the signed-in CLI and its quota.
func TestInstalledClaudeSession(t *testing.T) {
	if os.Getenv("MISTERMORPH_TEST_CLAUDE") != "1" {
		t.Skip("set MISTERMORPH_TEST_CLAUDE=1")
	}
	command, env, err := (shellenv.CoderEnv{}).Command("claude")
	if err != nil {
		t.Fatal(err)
	}
	req := Request{Backend: "claude", Command: command, Env: env, CWD: t.TempDir(), BypassApprovals: true}
	var runs []coderusage.Run
	var quota *coderusage.Quota
	req.Report = func(r coderusage.Run, q *coderusage.Quota) {
		runs = append(runs, r)
		if q != nil {
			quota = q
		}
	}
	var pids []int
	req.Process = func(pid int) { pids = append(pids, pid) }
	var sessions Sessions
	defer sessions.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	req.Task = "Remember the word heliotrope-41. Reply with exactly OK. Do not use tools or change files."
	out, err := sessions.Run(ctx, "run", req)
	if err != nil || !strings.Contains(out, "OK") {
		t.Fatalf("first task: out=%q err=%v", out, err)
	}
	req.Task = "Reply with exactly the word I asked you to remember. Do not use tools."
	out, err = sessions.Run(ctx, "run", req)
	if err != nil || !strings.Contains(out, "heliotrope-41") {
		t.Fatalf("second task: out=%q err=%v", out, err)
	}
	if len(pids) != 2 || pids[0] != pids[1] {
		t.Fatalf("pids = %v, want one process", pids)
	}
	for i, run := range runs {
		if len(run.Models) == 0 || run.Models[0].InputTokens <= 0 || run.Total().CostUSD <= 0 {
			t.Fatalf("task %d reported no usage: %+v", i, run)
		}
		t.Logf("task %d: %s", i, run.Summary())
	}
	t.Logf("quota: %+v", quota)
	sessions.Reset("run")
}

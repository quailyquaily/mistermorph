//go:build unix

package coderterm

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// claudeUsageTurn is what Claude Code writes for one task: the submitted text, and a reply.
func claudeUsageTurn(t *testing.T, task, messageID string, input, output int) string {
	t.Helper()
	user, err := json.Marshal("Coding task:\n" + normalizeTask(task) + taskEndRule)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":%s}}
{"type":"assistant","message":{"id":%q,"model":"claude-opus-5-5","content":[{"type":"text","text":"reply %s"}],"stop_reason":"end_turn","usage":{"input_tokens":%d,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":%d}}}
`, user, messageID, messageID, input, output)
}

// usageClaude is a stand-in Claude Code: it shows the idle prompt, and for each task it is given
// it appends that task's lines (turns/turnN.jsonl) to its transcript, and a sub-agent's
// (turns/agentN.jsonl) to a file of that sub-agent, exiting instead of going idle when the task is
// marked to fail (turns/failN).
func usageClaude(t *testing.T, dir string) (command, home, project, turns string) {
	t.Helper()
	home = filepath.Join(dir, "home")
	turns = filepath.Join(dir, "turns")
	project = filepath.Join(home, ".claude", "projects", "project")
	for _, d := range []string{project, turns} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	command = filepath.Join(dir, "claude")
	script := "#!/bin/sh\nid=\"$2\"\nfile='" + project + "'/\"$id\".jsonl\n" +
		"n=$(cat '" + turns + "/count' 2>/dev/null || echo 0)\nprintf '$'\n" +
		"while read line; do\n  case \"$line\" in *'Leave running only'*)\n" +
		"    n=$((n+1)); echo $n > '" + turns + "/count'\n" +
		"    if [ -f '" + turns + "'/agent$n.jsonl ]; then\n" +
		"      mkdir -p '" + project + "'/\"$id\"/subagents\n" +
		"      cat '" + turns + "'/agent$n.jsonl >> '" + project + "'/\"$id\"/subagents/agent-a$n.jsonl\n    fi\n" +
		"    cat '" + turns + "'/turn$n.jsonl >> \"$file\"\n" +
		"    if [ -f '" + turns + "'/fail$n ]; then exit 1; fi\n" +
		"    printf '\\n$' ;;\n  esac\ndone\n"
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return command, home, project, turns
}

func TestTerminalReportsUsageOncePerTask(t *testing.T) {
	dir := t.TempDir()
	command, home, project, turns := usageClaude(t, dir)
	for i, turn := range []string{
		claudeUsageTurn(t, "one", "msg_1", 100, 10),
		claudeUsageTurn(t, "two", "msg_2", 200, 20),
		claudeUsageTurn(t, "three", "msg_3", 300, 30),
		claudeUsageTurn(t, "four", "msg_4", 400, 40),
	} {
		if err := os.WriteFile(filepath.Join(turns, fmt.Sprintf("turn%d.jsonl", i+1)), []byte(turn), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(turns, "fail3"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	var sessions Sessions
	defer sessions.Close()
	var reports []Usage
	run := func(task string) (string, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return sessions.Run(ctx, "topic", Request{
			Backend: "claude", Command: command, CWD: dir, Task: task, LogRoot: dir,
			Env:   []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")},
			Usage: func(u Usage) { reports = append(reports, u) },
		})
	}
	// A task's usage of the one model: its responses (input, output), each apart, and their sum.
	opus := func(turns int, responses ...[2]int64) Usage {
		m := ModelUsage{Model: "claude-opus-5-5"}
		for _, r := range responses {
			m.InputTokens += r[0]
			m.OutputTokens += r[1]
			m.Responses = append(m.Responses, ResponseUsage{InputTokens: r[0], OutputTokens: r[1], Count: 1})
		}
		return Usage{Turns: turns, Models: []ModelUsage{m}}
	}

	if out, err := run("one"); err != nil || out != "reply msg_1" {
		t.Fatalf("first task: %q, %v", out, err)
	}
	if len(reports) != 1 || !reflect.DeepEqual(reports[0], opus(1, [2]int64{100, 10})) {
		t.Fatalf("first task reports = %+v", reports)
	}

	// What Claude Code spends between two tasks is counted with the later one.
	files, _ := filepath.Glob(filepath.Join(project, "*.jsonl"))
	if len(files) != 1 {
		t.Fatalf("transcripts = %v", files)
	}
	appendUsageFile(t, files[0], `{"type":"assistant","isCompactSummary":true,"message":{"id":"msg_between","model":"claude-opus-5-5","content":[{"type":"text","text":"summary"}],"stop_reason":null,"usage":{"input_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":3}}}
`)
	if out, err := run("two"); err != nil || out != "reply msg_2" {
		t.Fatalf("second task: %q, %v", out, err)
	}
	if len(reports) != 2 || !reflect.DeepEqual(reports[1], opus(1, [2]int64{7, 3}, [2]int64{200, 20})) {
		t.Fatalf("second task reports = %+v", reports)
	}

	// A task that fails reports what was written until then.
	if _, err := run("three"); err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("third task error = %v, want exited", err)
	}
	if len(reports) != 3 || !reflect.DeepEqual(reports[2], opus(1, [2]int64{300, 30})) {
		t.Fatalf("failed task reports = %+v", reports)
	}

	// The reopened conversation appends to the same file and counts on from where it was.
	if out, err := run("four"); err != nil || out != "reply msg_4" {
		t.Fatalf("fourth task: %q, %v", out, err)
	}
	if len(reports) != 4 || !reflect.DeepEqual(reports[3], opus(1, [2]int64{400, 40})) {
		t.Fatalf("resumed task reports = %+v", reports)
	}
}

// A conversation of an earlier runtime: its file's lines were used before this session started.
func TestResumedSessionStartsUsageAtTheFilesEnd(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	path := filepath.Join(home, ".claude", "projects", "project", "sid.jsonl")
	writeUsageFile(t, path, claudeUsageTranscript)
	command := filepath.Join(dir, "claude")
	if err := os.WriteFile(command, []byte("#!/bin/sh\nwhile read line; do :; done\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	req := Request{Backend: "claude", Command: command, CWD: dir, LogRoot: dir, Env: []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}}
	s, err := start(claudeBackend{}, req, resumePoint{id: "sid", cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if got := s.takeUsage(); len(got.Models) != 0 || got.Turns != 0 {
		t.Fatalf("usage of a resumed session = %+v, want none", got)
	}
	appendUsageFile(t, path, `{"type":"assistant","message":{"id":"msg_new","model":"claude-opus-5-5","content":[],"stop_reason":"end_turn","usage":{"input_tokens":4,"output_tokens":2}}}
`)
	want := Usage{Turns: 1, Models: []ModelUsage{{Model: "claude-opus-5-5", InputTokens: 4, OutputTokens: 2}}}
	if got := s.takeUsage(); !reflect.DeepEqual(sums(got), want) {
		t.Fatalf("usage = %+v, want %+v", got, want)
	}

	// A new session counts its file from the start.
	fresh, err := start(claudeBackend{}, req, resumePoint{})
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.close()
	fresh.id = "sid"
	if got := fresh.takeUsage(); len(got.Models) != 2 {
		t.Fatalf("usage of a new session = %+v", got)
	}
}

// What a task's rows are priced by reaches the Usage callback: the responses one by one, a
// sub-agent's among them, with their cache writes by lifetime. A later task counts on from the
// files' offsets and takes back what it corrects.
func TestTerminalReportsResponsesApart(t *testing.T) {
	dir := t.TempDir()
	command, home, _, turns := usageClaude(t, dir)
	const haiku, sonnet = "claude-haiku-5-5", "claude-sonnet-5-5"
	write := func(name, data string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(turns, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// The first task: two responses of the same size before the reply, a sub-agent's third, and
	// the sub-agent's 1-hour cache write.
	turn := claudeUsageTurn(t, "one", "msg_1", 100, 10)
	reply := turn[strings.Index(turn, "\n")+1:]
	write("turn1.jsonl", turn[:len(turn)-len(reply)]+
		claudeResponseLine("msg_h1", haiku, 2000, 48_000, 0, 1000, "")+
		claudeResponseLine("msg_h2", haiku, 2000, 48_000, 0, 1000, "")+reply)
	write("agent1.jsonl", claudeResponseLine("msg_h3", haiku, 2000, 48_000, 0, 1000, "")+
		claudeResponseLine("msg_s1", sonnet, 0, 0, 1000, 40, `{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1000}`))
	// The second: the sub-agent's response again with its final output, and the reply.
	write("turn2.jsonl", claudeUsageTurn(t, "two", "msg_2", 200, 20))
	write("agent2.jsonl", claudeResponseLine("msg_s1", sonnet, 0, 0, 1000, 90, `{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1000}`)+
		claudeResponseLine("msg_h3", haiku, 2000, 48_000, 0, 1000, ""))

	var sessions Sessions
	defer sessions.Close()
	var reports []Usage
	run := func(task string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if _, err := sessions.Run(ctx, "topic", Request{
			Backend: "claude", Command: command, CWD: dir, Task: task, LogRoot: dir,
			Env:   []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")},
			Usage: func(u Usage) { reports = append(reports, u) },
		}); err != nil {
			t.Fatalf("task %s: %v", task, err)
		}
	}
	run("one")
	response := ResponseUsage{InputTokens: 50_000, CachedInputTokens: 48_000, OutputTokens: 1000, Count: 1}
	hour := map[string]int64{"ephemeral_1h_input_tokens": 1000}
	want := Usage{Turns: 1, Models: []ModelUsage{
		{Model: haiku, InputTokens: 150_000, CachedInputTokens: 144_000, OutputTokens: 3000,
			Responses: []ResponseUsage{response, response, response}},
		{Model: "claude-opus-5-5", InputTokens: 100, OutputTokens: 10,
			Responses: []ResponseUsage{{InputTokens: 100, OutputTokens: 10, Count: 1}}},
		{Model: sonnet, InputTokens: 1000, CacheCreationInputTokens: 1000, OutputTokens: 40, CacheCreation: hour,
			Responses: []ResponseUsage{{InputTokens: 1000, CacheCreationInputTokens: 1000, OutputTokens: 40, CacheCreation: hour, Count: 1}}},
	}}
	if len(reports) != 1 || !reflect.DeepEqual(reports[0], want) {
		t.Fatalf("first task reports = %+v\nwant %+v", reports, want)
	}

	run("two")
	want = Usage{Turns: 1, Models: []ModelUsage{
		{Model: "claude-opus-5-5", InputTokens: 200, OutputTokens: 20,
			Responses: []ResponseUsage{{InputTokens: 200, OutputTokens: 20, Count: 1}}},
		// The cache write was counted with the first task: only the 50 more output tokens are new.
		{Model: sonnet, OutputTokens: 50, Responses: []ResponseUsage{
			{InputTokens: 1000, CacheCreationInputTokens: 1000, OutputTokens: 40, CacheCreation: hour, Count: -1},
			{InputTokens: 1000, CacheCreationInputTokens: 1000, OutputTokens: 90, CacheCreation: hour, Count: 1},
		}},
	}}
	if len(reports) != 2 || !reflect.DeepEqual(reports[1], want) {
		t.Fatalf("second task reports = %+v\nwant %+v", reports[1:], want)
	}
}

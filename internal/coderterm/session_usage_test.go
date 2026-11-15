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

// A stand-in Claude Code: it shows the idle prompt, and for each task it is given it appends that
// task's lines to its transcript, exiting instead of going idle when the task is marked to fail.
func TestTerminalReportsUsageOncePerTask(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	turns := filepath.Join(dir, "turns")
	project := filepath.Join(home, ".claude", "projects", "project")
	for _, d := range []string{project, turns} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	command := filepath.Join(dir, "claude")
	script := "#!/bin/sh\nid=\"$2\"\nfile='" + project + "'/\"$id\".jsonl\n" +
		"n=$(cat '" + turns + "/count' 2>/dev/null || echo 0)\nprintf '$'\n" +
		"while read line; do\n  case \"$line\" in *'Leave running only'*)\n" +
		"    n=$((n+1)); echo $n > '" + turns + "/count'\n" +
		"    cat '" + turns + "'/turn$n.jsonl >> \"$file\"\n" +
		"    if [ -f '" + turns + "'/fail$n ]; then exit 1; fi\n" +
		"    printf '\\n$' ;;\n  esac\ndone\n"
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
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
	opus := func(turns int, input, output int64) Usage {
		return Usage{Turns: turns, Models: []ModelUsage{{Model: "claude-opus-5-5", InputTokens: input, OutputTokens: output}}}
	}

	if out, err := run("one"); err != nil || out != "reply msg_1" {
		t.Fatalf("first task: %q, %v", out, err)
	}
	if len(reports) != 1 || !reflect.DeepEqual(reports[0], opus(1, 100, 10)) {
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
	if len(reports) != 2 || !reflect.DeepEqual(reports[1], opus(1, 207, 23)) {
		t.Fatalf("second task reports = %+v", reports)
	}

	// A task that fails reports what was written until then.
	if _, err := run("three"); err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("third task error = %v, want exited", err)
	}
	if len(reports) != 3 || !reflect.DeepEqual(reports[2], opus(1, 300, 30)) {
		t.Fatalf("failed task reports = %+v", reports)
	}

	// The reopened conversation appends to the same file and counts on from where it was.
	if out, err := run("four"); err != nil || out != "reply msg_4" {
		t.Fatalf("fourth task: %q, %v", out, err)
	}
	if len(reports) != 4 || !reflect.DeepEqual(reports[3], opus(1, 400, 40)) {
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
	if got := s.takeUsage(); !reflect.DeepEqual(got, want) {
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

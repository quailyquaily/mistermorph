//go:build unix

package coderterm

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCancelWhileWaitingForAnswer(t *testing.T) {
	dir := t.TempDir()
	command := filepath.Join(dir, "claude")
	script := "#!/bin/sh\nprintf 'Permission Required: Accessing workspace:\\r\\nworkspace\\r\\ny. Yes, I trust this folder\\r\\nn. No, exit\\r\\nEnter y/n:\\r\\nEnter to confirm · Esc to cancel'\nsleep 30\n"
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	var sessions Sessions
	defer sessions.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	waiting := make(chan struct{})
	req := Request{Backend: "claude", Command: command, CWD: dir, Task: "test", LogRoot: dir, Ask: func(ctx context.Context, _ Question) (Answer, error) {
		close(waiting)
		<-ctx.Done()
		return Answer{}, ctx.Err()
	}}
	done := make(chan error, 1)
	go func() { _, err := sessions.Run(ctx, "topic", req); done <- err }()
	select {
	case <-waiting:
	case <-ctx.Done():
		t.Fatal("question never opened")
	}
	if _, err := sessions.Run(ctx, "topic", req); err == nil || !strings.Contains(err.Error(), "already handling") {
		t.Fatalf("overlap error=%v", err)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not close the terminal")
	}
	if len(sessions.items) != 0 {
		t.Fatal("failed session retained")
	}
}

func TestTranscriptIgnoresEditsAndWaitsForCompleteLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	data := `{"type":"user","message":{"content":"task"}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"content":"private file contents"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","content":"private output"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"## Done"}]}}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	r := claudeTranscript{path: path}
	if err := r.read(); err != nil {
		t.Fatal(err)
	}
	if r.user != "task" || r.assistant != "" {
		t.Fatalf("user=%q assistant=%q", r.user, r.assistant)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("\n")
	f.Close()
	if err := r.read(); err != nil {
		t.Fatal(err)
	}
	if r.assistant != "## Done" {
		t.Fatal(r.assistant)
	}
}

func TestTranscriptWaitsForThisTurnsFinalMessage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	data := `{"type":"assistant","message":{"id":"old","content":[{"type":"text","text":"old answer"}],"stop_reason":"end_turn"}}
{"type":"user","message":{"content":"task"}}
{"type":"assistant","message":{"id":"working","content":[{"type":"text","text":"Editing now"},{"type":"tool_use","name":"Write"}],"stop_reason":"tool_use"}}
`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	r := claudeTranscript{path: path, expected: "task"}
	if err := r.read(); err != nil {
		t.Fatal(err)
	}
	if r.complete || r.assistant != "Editing now" {
		t.Fatalf("tool call completed turn: %+v", r)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString(`{"type":"assistant","message":{"id":"final","content":[{"type":"text","text":"## Done"}],"stop_reason":null}}
{"type":"assistant","message":{"id":"final","content":[{"type":"text","text":"**Result**"}],"stop_reason":"end_turn"}}
`)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := r.read(); err != nil {
		t.Fatal(err)
	}
	if !r.complete || r.assistant != "## Done\n\n**Result**" {
		t.Fatalf("final response: %+v", r)
	}
}

func TestFailedSessionResumes(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	broken := filepath.Join(dir, "broken")
	command := filepath.Join(dir, "claude")
	// Records its arguments, shows an idle prompt, and exits once a task arrives.
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + argsPath + "'\n" +
		"if [ \"$1\" = --resume ] && [ -f '" + broken + "' ]; then exit 3; fi\n" +
		"printf '$'\nread line\nexit 1\n"
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	var sessions Sessions
	defer sessions.Close()
	req := Request{Backend: "claude", Command: command, CWD: dir, Task: "test", LogRoot: dir, Env: []string{"HOME=" + dir, "PATH=" + os.Getenv("PATH")}}
	run := func() (flag, id string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := sessions.Run(ctx, "topic", req); err == nil || !strings.Contains(err.Error(), "exited") {
			t.Fatalf("run error = %v, want exited", err)
		}
		data, err := os.ReadFile(argsPath)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		fields := strings.Fields(lines[len(lines)-1])
		return fields[0], fields[1]
	}
	resumable := func() string { return sessions.resume[sessionKey{"topic", "claude"}].id }

	flag, first := run()
	if flag != "--session-id" || resumable() != first {
		t.Fatalf("fresh run: flag=%s remembered=%q want %q", flag, resumable(), first)
	}
	if flag, id := run(); flag != "--resume" || id != first || resumable() != first {
		t.Fatalf("resume: %s %s remembered=%q want %q", flag, id, resumable(), first)
	}
	// A reopen that fails before the task reaches Claude is not retried.
	if err := os.WriteFile(broken, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if flag, _ := run(); flag != "--resume" || resumable() != "" {
		t.Fatalf("broken resume: flag=%s remembered=%q", flag, resumable())
	}
	if flag, id := run(); flag != "--session-id" || id == first || resumable() != id {
		t.Fatalf("after broken resume: %s %s remembered=%q", flag, id, resumable())
	}
	sessions.Reset("topic")
	if resumable() != "" {
		t.Fatal("reset kept the resume point")
	}
	if flag, _ := run(); flag != "--session-id" {
		t.Fatalf("after reset: flag=%s", flag)
	}
	// A different working directory starts fresh.
	req.CWD = t.TempDir()
	if flag, _ := run(); flag != "--session-id" {
		t.Fatalf("new cwd: flag=%s", flag)
	}
}

func TestTerminalReportsProcessForNewAndReusedSession(t *testing.T) {
	for _, reuse := range []bool{false, true} {
		t.Run(fmt.Sprint(reuse), func(t *testing.T) {
			dir := t.TempDir()
			command := filepath.Join(dir, "claude")
			if err := os.WriteFile(command, []byte("#!/bin/sh\nwhile read line; do :; done\n"), 0700); err != nil {
				t.Fatal(err)
			}
			req := Request{Backend: "claude", Command: command, CWD: dir, Task: "test", LogRoot: dir, Env: []string{"HOME=" + dir, "PATH=" + os.Getenv("PATH")}}
			var sessions Sessions
			defer sessions.Close()
			key := sessionKey{"topic", "claude"}
			if reuse {
				backend, _ := backendFor("claude")
				started, err := start(backend, req, "")
				if err != nil {
					t.Fatal(err)
				}
				sessions.items = map[sessionKey]*session{key: started}
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			called := false
			req.Process = func(pid int) {
				called = true
				if pid <= 0 || pid != sessions.items[key].cmd.Process.Pid {
					t.Errorf("incorrect terminal PID: %d", pid)
				}
				cancel()
			}
			_, _ = sessions.Run(ctx, "topic", req)
			if !called {
				t.Fatal("missing terminal process callback")
			}
		})
	}
	t.Run("failed start", func(t *testing.T) {
		dir := t.TempDir()
		var sessions Sessions
		defer sessions.Close()
		_, err := sessions.Run(context.Background(), "topic", Request{Backend: "claude", Command: filepath.Join(dir, "missing"), CWD: dir, Task: "test", LogRoot: dir, Process: func(int) { t.Error("PID reported for failed start") }})
		if err == nil {
			t.Fatal("expected start error")
		}
	})
}

func TestNormalizeTask(t *testing.T) {
	for _, tc := range []struct{ name, in, want string }{
		{"plain", "task", "task"},
		{"trailing newline", "task\n", "task"},
		{"trailing spaces", "task   ", "task"},
		{"tab", "a\tb", "a    b"},
		{"inner whitespace kept", "  a  \n\nb", "  a  \n\nb"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeTask(tc.in); got != tc.want {
				t.Fatalf("normalizeTask(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

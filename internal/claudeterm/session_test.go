//go:build unix

package claudeterm

import (
	"context"
	"errors"
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
	req := Request{Command: command, CWD: dir, Task: "test", LogRoot: dir, Ask: func(ctx context.Context, _ Question) (Answer, error) {
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
	r := transcriptReader{path: path}
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
	r := transcriptReader{path: path, expected: "task"}
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

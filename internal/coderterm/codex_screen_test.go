package coderterm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Screens captured from Codex 0.166.0 at 120x40.
func codexScreen(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "codex", name+".txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestCodexScreens(t *testing.T) {
	for _, tt := range []struct {
		name    string
		idle    bool
		options []string
		text    string
	}{
		{name: "idle", idle: true},
		{name: "busy"},
		{name: "status", idle: true},
		{name: "approval", options: []string{"Yes, proceed", "Yes, and don't ask again for commands that start with `touch shell.txt`", "No, and tell Codex what to do differently"},
			text: "Would you like to run the following command?\nEnvironment: local\nReason: Create the requested file outside the sandbox\n$ touch shell.txt"},
		{name: "trust", options: []string{"Trust and continue", "Quit"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			v := parseCodexScreen(codexScreen(t, tt.name))
			if v.problem != "" || v.idle != tt.idle {
				t.Fatalf("idle=%v problem=%q", v.idle, v.problem)
			}
			if tt.options == nil {
				if v.question != nil {
					t.Fatalf("unexpected question %+v", v.question)
				}
				return
			}
			q := v.question
			if q == nil || !q.ChoicesOnly || !v.immediate || strings.Join(q.Options, "|") != strings.Join(tt.options, "|") {
				t.Fatalf("question=%+v", q)
			}
			if strings.Join(v.keys, "") != "123"[:len(tt.options)] {
				t.Fatalf("keys=%v", v.keys)
			}
			if tt.text != "" && q.Text != tt.text {
				t.Fatalf("text=%q", q.Text)
			}
		})
	}
	trust := parseCodexScreen(codexScreen(t, "trust"))
	if !strings.HasPrefix(trust.question.Text, "Folder access\n/work\nTrust this folder?") || !trust.selectThenEnter || trust.selected != 0 {
		t.Fatalf("trust prompt: %+v", trust)
	}
	if approval := parseCodexScreen(codexScreen(t, "approval")); approval.selectThenEnter || approval.selected != 0 {
		t.Fatalf("approval prompt: %+v", approval)
	}
	if id := (codexBackend{}).sessionID(codexScreen(t, "status")); id != "01a191ef-c6db-7030-a621-99a29cf43de8" {
		t.Fatalf("session id %q", id)
	}
}

func TestCodexTurnFollowsOnlyTheSubmittedTask(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	write := func(lines ...string) {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		for _, line := range lines {
			f.WriteString(line)
		}
	}
	write(`{"type":"event_msg","payload":{"type":"task_started","turn_id":"old"}}`+"\n",
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"old","last_agent_message":"old answer"}}`+"\n",
		`{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}`+"\n",
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}`+"\n",
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Coding task:\nwork"}]}}`+"\n",
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"## Do`)
	r := codexTurn{path: path, expected: "Coding task:\nwork"}
	if err := r.read(); err != nil {
		t.Fatal(err)
	}
	if out, done, err := r.state(); done || err != nil || out != "" || r.turnID != "t1" {
		t.Fatalf("partial line: %q %v %v turn=%q", out, done, err, r.turnID)
	}
	write(`ne"}}` + "\n")
	if err := r.read(); err != nil {
		t.Fatal(err)
	}
	if out, done, err := r.state(); !done || err != nil || out != "## Done" {
		t.Fatalf("complete: %q %v %v", out, done, err)
	}

	for _, tt := range []struct{ name, line, want string }{
		{"aborted", `{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t2","reason":"interrupted"}}`, "interrupted"},
		{"api error", `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t2","last_agent_message":null,"error":{"message":"probe API failure"}}}`, "probe API failure"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rollout.jsonl")
			data := `{"type":"event_msg","payload":{"type":"task_started","turn_id":"t2"}}` + "\n" +
				`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"task"}]}}` + "\n" + tt.line + "\n"
			if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			r := codexTurn{path: path, expected: "task"}
			if err := r.read(); err != nil {
				t.Fatal(err)
			}
			if _, _, err := r.state(); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

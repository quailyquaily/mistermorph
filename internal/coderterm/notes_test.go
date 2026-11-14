package coderterm

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestClaudeTranscriptNotesWhatIsSaidWhileWorking(t *testing.T) {
	said := func(id, text, stop string) string {
		return fmt.Sprintf(`{"type":"assistant","message":{"id":%q,"content":[{"type":"text","text":%q}],"stop_reason":%q}}`+"\n", id, text, stop)
	}
	const (
		task   = `{"type":"user","message":{"content":"task"}}` + "\n"
		tool   = `{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"x","name":"Bash"}],"stop_reason":"tool_use"}}` + "\n"
		result = `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}` + "\n"
		side   = `{"type":"assistant","isSidechain":true,"message":{"id":"s","content":[{"type":"text","text":"a sub-agent's words"}],"stop_reason":"tool_use"}}` + "\n"
		launch = `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"launched"}]},"toolUseResult":{"isAsync":true,"agentId":"t-a"}}` + "\n"
		report = `{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>t-a</task-id>\n</task-notification>"}` + "\n"
	)
	steps := []struct {
		write string
		notes []string
		reply string // the reply once the task is done
	}{
		{write: said("old", "before the task", "tool_use") + task},
		// Text beside a tool call is said at once; a sub-agent's is not ours.
		{write: said("m1", "Still waiting on the gate.", "tool_use") + tool + side + result, notes: []string{"Still waiting on the gate."}},
		// A turn that ends while an agent runs: what it said is a note once Claude goes on.
		{write: launch + said("m2", "Launched; I will report.", "end_turn")},
		{write: report + said("m3", "FINAL", "end_turn"), notes: []string{"Launched; I will report."}, reply: "FINAL"},
	}
	path := filepath.Join(t.TempDir(), "session.jsonl")
	r := claudeTranscript{path: path, expected: "task"}
	for i, step := range steps {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.WriteString(step.write)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		if err := r.read(); err != nil {
			t.Fatal(err)
		}
		if notes := r.takeNotes(); !reflect.DeepEqual(notes, step.notes) {
			t.Fatalf("step %d: notes = %q, want %q", i, notes, step.notes)
		}
		text, done, err := r.state()
		if err != nil || done != (step.reply != "") || (done && text != step.reply) {
			t.Fatalf("step %d: text=%q done=%v err=%v", i, text, done, err)
		}
	}
	if notes := r.takeNotes(); len(notes) != 0 {
		t.Fatalf("the reply was noted too: %q", notes)
	}
}

func TestCodexTurnNotesItsCommentary(t *testing.T) {
	message := func(turn, phase, text string) string {
		return fmt.Sprintf(`{"type":"event_msg","payload":{"type":"item_completed","turn_id":%q,"item":{"type":"AgentMessage","phase":%q,"content":[{"type":"Text","text":%q}]}}}`+"\n", turn, phase, text)
	}
	root := t.TempDir()
	day := filepath.Join(root, "2026", "11", "14")
	if err := os.MkdirAll(day, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(day, "rollout-2026-11-14T00-00-00-p.jsonl")
	rollout := message("t0", "commentary", "an earlier task's") +
		`{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"task"}]}}` + "\n" +
		message("t1", "commentary", "Starting the sub-agent, then returning.") +
		message("t1", "commentary", strings.Repeat("长", noteMax)) +
		message("t1", "final_answer", "started") +
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"started"}}` + "\n"
	if err := os.WriteFile(path, []byte(rollout), 0o600); err != nil {
		t.Fatal(err)
	}
	r := codexBackend{}.newTurn(path, 0, "task").(*codexTurn)
	if err := r.read(); err != nil {
		t.Fatal(err)
	}
	notes := r.takeNotes()
	if len(notes) != 2 || notes[0] != "Starting the sub-agent, then returning." {
		t.Fatalf("notes = %.80q", notes)
	}
	// A long one is cut between characters.
	if len(notes[1]) > noteMax+8 || !strings.HasSuffix(notes[1], " …") || strings.ContainsRune(notes[1], '�') {
		t.Fatalf("long note: %d bytes, ends %q", len(notes[1]), notes[1][len(notes[1])-8:])
	}
	if text, done, err := r.state(); err != nil || !done || text != "started" {
		t.Fatalf("text=%q done=%v err=%v", text, done, err)
	}
	if again := r.takeNotes(); len(again) != 0 {
		t.Fatalf("notes taken twice: %q", again)
	}
}

package coderterm

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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

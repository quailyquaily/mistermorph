package coderterm

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexTurnWaitsForSubAgents(t *testing.T) {
	// Each line is stamped a millisecond after the one before, across all rollouts.
	clock := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	stamp := func() string {
		clock = clock.Add(time.Millisecond)
		return clock.Format(time.RFC3339Nano)
	}
	ev := func(kind, turn, extra string) string {
		return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":%q,"turn_id":%q%s}}`+"\n", stamp(), kind, turn, extra)
	}
	started := func(turn string) string { return ev("task_started", turn, "") }
	complete := func(turn, reply string) string {
		return ev("task_complete", turn, fmt.Sprintf(`,"last_agent_message":%q`, reply))
	}
	activity := func(kind, id string) string {
		return fmt.Sprintf(`{"type":"event_msg","payload":{"type":"sub_agent_activity","kind":%q,"agent_thread_id":%q,"agent_path":"/root/%s"}}`+"\n", kind, id, id)
	}
	// Codex 0.169 records the activity as a completed item.
	item := func(kind, id string) string {
		return fmt.Sprintf(`{"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"SubAgentActivity","kind":%q,"agent_thread_id":%q,"agent_path":"/root/%s"}}}`+"\n", kind, id, id)
	}
	task := started("t1") + `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"task"}]}}` + "\n"

	// Each step appends to rollouts by thread ("parent" or a sub-agent's ID), moves the clock,
	// then says whether the task is done and, when it is, the reply.
	type step struct {
		write map[string]string
		after time.Duration
		done  bool
		reply string
	}
	tests := []struct {
		name  string
		steps []step
	}{
		{"waited for inside the turn", []step{
			{write: map[string]string{"parent": task + activity("started", "a"), "a": started("x") + complete("x", "a done")}},
			{write: map[string]string{"parent": complete("t1", "all done")}, done: true, reply: "all done"},
		}},
		{"finishes after the reply", []step{
			{write: map[string]string{"parent": task + activity("started", "a"), "a": started("x")}},
			{write: map[string]string{"parent": complete("t1", "started a")}},
			{write: map[string]string{"a": complete("x", "a done")}, done: true, reply: "started a\n\n[Sub-agent /root/a finished after this reply]\na done"},
		}},
		{"activity recorded as an item", []step{
			{write: map[string]string{"parent": task + item("started", "a"), "a": started("x")}},
			{write: map[string]string{"parent": complete("t1", "started a")}},
			{write: map[string]string{"a": complete("x", "KIWI"), "parent": item("completed", "a")}, done: true, reply: "started a\n\n[Sub-agent /root/a finished after this reply]\nKIWI"},
		}},
		{"parent woken by it", []step{
			{write: map[string]string{"parent": task + activity("started", "a"), "a": started("x")}},
			{write: map[string]string{"parent": complete("t1", "started a")}},
			{write: map[string]string{"a": complete("x", "a done"), "parent": started("t2")}},
			{write: map[string]string{"parent": complete("t2", "a reported")}, done: true, reply: "a reported"},
		}},
		{"parent woken twice", []step{
			{write: map[string]string{"parent": task + activity("started", "a") + activity("started", "b"), "a": started("x"), "b": started("y")}},
			{write: map[string]string{"parent": complete("t1", "started both")}},
			{write: map[string]string{"a": complete("x", "a done"), "parent": started("t2") + complete("t2", "one back")}},
			{write: map[string]string{"b": complete("y", "b done"), "parent": started("t3")}},
			{write: map[string]string{"parent": complete("t3", "FINAL")}, done: true, reply: "FINAL"},
		}},
		{"finishes after the woken turn", []step{
			{write: map[string]string{"parent": task + activity("started", "a") + activity("started", "b"), "a": started("x"), "b": started("y")}},
			{write: map[string]string{"parent": complete("t1", "started both")}},
			{write: map[string]string{"a": complete("x", "a done"), "parent": started("t2") + complete("t2", "one back")}},
			{write: map[string]string{"b": complete("y", "b done")}, done: true, reply: "one back\n\n[Sub-agent /root/b finished after this reply]\nb done"},
		}},
		{"no text of its own", []step{
			{write: map[string]string{"parent": task + activity("started", "a"), "a": started("x")}},
			{write: map[string]string{"parent": complete("t1", "")}},
			{write: map[string]string{"a": complete("x", "a done")}, done: true, reply: "[Sub-agent /root/a finished after this reply]\na done"},
		}},
		{"nested", []step{
			{write: map[string]string{"parent": task + activity("started", "a"), "a": started("x") + activity("started", "b"), "b": started("y")}},
			{write: map[string]string{"parent": complete("t1", "started a"), "a": complete("x", "a done")}},
			{write: map[string]string{"b": complete("y", "b done")}, done: true, reply: "started a\n\n[Sub-agent /root/a finished after this reply]\na done\n\n[Sub-agent /root/b finished after this reply]\nb done"},
		}},
		{"rollout never written", []step{
			{write: map[string]string{"parent": task + activity("started", "a") + complete("t1", "started a")}},
			{after: codexAgentGrace - time.Second},
			{after: 2 * time.Second, done: true, reply: "started a"},
		}},
		{"message that starts no turn", []step{
			{write: map[string]string{"parent": task + activity("started", "a"), "a": started("x") + complete("x", "a done")}},
			{write: map[string]string{"parent": activity("interacted", "a") + complete("t1", "told a")}},
			{after: codexAgentGrace + time.Second, done: true, reply: "told a"},
		}},
		{"reply read before an earlier one of a sub-agent", []step{
			{write: map[string]string{"parent": task + activity("started", "a"), "a": started("x")}},
			// a's reply is written first; the poll reads the parent's first.
			{write: map[string]string{"a": complete("x", "a done"), "parent": complete("t1", "all done")}, done: true, reply: "all done"},
		}},
		{"sub-agent messages this session", []step{
			{write: map[string]string{"parent": task + activity("started", "a"), "a": started("x") + activity("interacted", "p")}},
			{write: map[string]string{"a": complete("x", "a done"), "parent": complete("t1", "all done")}, done: true, reply: "all done"},
		}},
		{"agents from an earlier task", []step{
			{write: map[string]string{"parent": activity("started", "old") + task + complete("t1", "done")}, done: true, reply: "done"},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			day := filepath.Join(root, "2026", "11", "14")
			if err := os.MkdirAll(day, 0o700); err != nil {
				t.Fatal(err)
			}
			path := func(thread string) string {
				if thread == "parent" {
					thread = "p"
				}
				return filepath.Join(day, "rollout-2026-11-14T00-00-00-"+thread+".jsonl")
			}
			now := time.Unix(0, 0)
			r := codexBackend{}.newTurn(path("parent"), 0, "task").(*codexTurn)
			if r.root != root || r.thread != "p" {
				t.Fatalf("root %q thread %q, want %q and p", r.root, r.thread, root)
			}
			r.now = func() time.Time { return now }
			for i, s := range tt.steps {
				for thread, data := range s.write {
					f, err := os.OpenFile(path(thread), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
					if err != nil {
						t.Fatal(err)
					}
					_, err = f.WriteString(data)
					f.Close()
					if err != nil {
						t.Fatal(err)
					}
				}
				// Write order across files is the test's; read once per file set, as a poll would.
				if err := r.read(); err != nil {
					t.Fatal(err)
				}
				now = now.Add(s.after)
				out, done, err := r.state()
				if err != nil {
					t.Fatal(err)
				}
				if done != s.done || (done && out != s.reply) {
					t.Fatalf("step %d: done=%v reply=%q, want done=%v reply=%q", i, done, out, s.done, s.reply)
				}
			}
		})
	}
}

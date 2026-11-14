package consolecmd

import (
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// The run's history carries each finished turn's tool record; the lightweight decision and a
// steer's reply go by the conversation alone.
func TestConsoleRunHistoryHasToolRecordsAndTheConversationHasNone(t *testing.T) {
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	created := time.Now().UTC().Add(-time.Hour)
	finished := created.Add(time.Minute)
	if err := store.Upsert(daemonruntime.TaskInfo{
		ID: "t1", TopicID: "topic", Task: "ask the coder", Status: daemonruntime.TaskDone, CreatedAt: created, FinishedAt: &finished,
		Result: map[string]any{
			"final": map[string]any{"output": "started"},
			"trace": map[string]any{"entries": []any{map[string]any{"event": map[string]any{
				"kind": "tool_done", "tool_name": "coder", "args": map[string]any{"coder": "codex"}, "text": "started\n\nKIWI",
			}}}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	r := &consoleLocalRuntime{store: store}
	job := consoleLocalTaskJob{TaskID: "t2", TopicID: "topic", CreatedAt: time.Now().UTC()}
	kinds := func(items []chathistory.ChatHistoryItem) (out []string) {
		for _, item := range items {
			out = append(out, item.Kind)
		}
		return out
	}
	run := r.loadConsoleRunHistory(job)
	if got := kinds(run); len(got) != 3 || got[1] != chathistory.KindToolRecord {
		t.Fatalf("run history kinds = %v", got)
	}
	if got := kinds(r.loadConsoleTopicHistory(job)); len(got) != 2 || got[0] != chathistory.KindInboundUser || got[1] != chathistory.KindOutboundAgent {
		t.Fatalf("conversation kinds = %v", got)
	}
}

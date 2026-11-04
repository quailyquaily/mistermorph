package consolecmd

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestConsoleMessageReactOriginAndLiveUpdates(t *testing.T) {
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"origin", "later"} {
		if err := store.Upsert(daemonruntime.TaskInfo{ID: id, TopicID: "a", Task: id, Conversation: &taskdomain.TaskConversation{ConversationID: "console:a"}}); err != nil {
			t.Fatal(err)
		}
	}
	hub := newConsoleStreamHub()
	frames, cancel := hub.Subscribe("origin")
	defer cancel()
	tool := newConsoleMessageReactTool(store, hub, consoleLocalTaskJob{TaskID: "origin", TopicID: "a", ConversationKey: "console:a"})
	for _, emoji := range []string{"👍", "👍", "❤️", "👩🏽‍💻", "🇯🇵", "♾️", "⁉️", "〰️", "〽️", "1️⃣"} {
		result, err := tool.Execute(context.Background(), map[string]any{"emoji": emoji})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(result, "reaction") || strings.Contains(result, "sent emoji message") {
			t.Fatalf("result = %q", result)
		}
		frame := <-frames
		if frame.TaskID != "origin" || frame.UserReaction != emoji || frame.Text != "" || frame.Done {
			t.Fatalf("frame = %#v", frame)
		}
		origin, _ := store.Get("origin")
		later, _ := store.Get("later")
		if origin.UserReaction != emoji || later.UserReaction != "" {
			t.Fatalf("origin=%#v later=%#v", origin, later)
		}
	}
	hub.PublishPreview("origin", "working")
	replay, unsub := hub.Subscribe("origin")
	defer unsub()
	if got := <-replay; got.UserReaction != "1️⃣" {
		t.Fatalf("replay lost reaction: %#v", got)
	}
	for _, params := range []map[string]any{{}, {"emoji": ""}, {"emoji": 1}, {"emoji": "hello"}, {"emoji": "👍❤️"}, {"emoji": "👍", "task_id": "later"}} {
		if _, err := tool.Execute(context.Background(), params); err == nil {
			t.Fatalf("accepted invalid params: %#v", params)
		}
	}
	for _, job := range []consoleLocalTaskJob{
		{}, {TaskID: "missing", TopicID: "a", ConversationKey: "console:a"},
		{TaskID: "origin", TopicID: "b", ConversationKey: "console:b"},
		{TaskID: "origin", TopicID: "a", ConversationKey: "slack:a"},
	} {
		tool := newConsoleMessageReactTool(store, hub, job)
		if _, err := tool.Execute(context.Background(), map[string]any{"emoji": "👍"}); err == nil {
			t.Fatalf("accepted invalid target: %#v", job)
		}
	}
}

func TestConsoleMessageReactPersistenceFailure(t *testing.T) {
	journal, err := taskdomain.NewJournal(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{RootDir: t.TempDir(), Persist: true, Journal: journal})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert(daemonruntime.TaskInfo{ID: "origin", TopicID: "a", Task: "hello", Conversation: &taskdomain.TaskConversation{ConversationID: "console:a"}}); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	hub := newConsoleStreamHub()
	tool := newConsoleMessageReactTool(store, hub, consoleLocalTaskJob{TaskID: "origin", TopicID: "a", ConversationKey: "console:a"})
	if result, err := tool.Execute(context.Background(), map[string]any{"emoji": "👍"}); err == nil || result != "" {
		t.Fatalf("result = %q, err = %v", result, err)
	}
	if frame, ok := hub.Latest("origin"); ok {
		t.Fatalf("published failed reaction: %#v", frame)
	}
}

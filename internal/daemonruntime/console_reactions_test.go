package daemonruntime

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestConsoleUserReactionPersistenceAndScope(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: filepath.Join(root, "tasks"), JournalDir: filepath.Join(root, "journal"), Persist: true, SkipRecovery: true}
	store, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range []TaskInfo{
		{ID: "origin", TopicID: "a", Task: "Original message", Status: TaskRunning, Conversation: &taskdomain.TaskConversation{ConversationID: "console:a"}},
		{ID: "later", TopicID: "a", Task: "New message", Status: TaskQueued, CreatedAt: time.Now().Add(time.Second), Conversation: &taskdomain.TaskConversation{ConversationID: "console:a"}},
		{ID: "other", TopicID: "b", Task: "Other conversation", Conversation: &taskdomain.TaskConversation{ConversationID: "console:b"}},
		{ID: "no-message", TopicID: "a", Conversation: &taskdomain.TaskConversation{ConversationID: "console:a"}},
	} {
		if err := store.Upsert(task); err != nil {
			t.Fatal(err)
		}
	}
	origin, _ := store.Get("origin")
	raw, _ := json.Marshal(origin)
	if strings.Contains(string(raw), "user_reaction") {
		t.Fatalf("initial reaction: %s", raw)
	}
	for index, emoji := range []string{"👍", "👍", "❤️"} {
		before := store.projectionCursor
		if err := store.SetUserReaction("origin", "a", "console:a", emoji); err != nil {
			t.Fatal(err)
		}
		if index == 1 && store.projectionCursor != before {
			t.Fatal("retry appended a journal event")
		}
		got, _ := store.Get("origin")
		if got.UserReaction != emoji {
			t.Fatalf("reaction = %q, want %q", got.UserReaction, emoji)
		}
	}
	for _, tc := range []struct{ id, topic, conversation, emoji, want string }{
		{"", "a", "console:a", "👍", "target"},
		{"missing", "a", "console:a", "👍", "not found"},
		{"other", "a", "console:a", "👍", "unauthorized"},
		{"origin", "b", "console:a", "👍", "unauthorized"},
		{"origin", "a", "console:b", "👍", "unauthorized"},
		{"origin", "", "", "👍", "target"},
		{"no-message", "a", "console:a", "👍", "user message"},
		{"origin", "a", "console:a", "", "emoji"},
	} {
		t.Run(tc.id+tc.topic+tc.conversation+tc.want, func(t *testing.T) {
			err := store.SetUserReaction(tc.id, tc.topic, tc.conversation, tc.emoji)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
	// Completion writes and journal replay must retain the reaction separately from the reply.
	if err := store.Update("origin", func(info *TaskInfo) {
		info.Status = TaskDone
		info.Result = map[string]any{"final": map[string]any{"output": ""}}
	}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range reloaded.List(TaskListOptions{Limit: 20}) {
		want := ""
		if task.ID == "origin" {
			want = "❤️"
		}
		if task.UserReaction != want {
			t.Fatalf("%s reaction = %q, want %q", task.ID, task.UserReaction, want)
		}
	}
	got, ok := reloaded.Get("origin")
	if !ok || got.UserReaction != "❤️" {
		t.Fatalf("reloaded = %#v", got)
	}
	raw, err = json.Marshal(got)
	if err != nil || !strings.Contains(string(raw), `"user_reaction":"❤️"`) {
		t.Fatalf("transport = %s, %v", raw, err)
	}
}

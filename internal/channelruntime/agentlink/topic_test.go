package agentlink

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

func TestRecordAgentTaskNamesTheAgentsTopic(t *testing.T) {
	root := t.TempDir()
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{RootDir: root, Persist: true, JournalDir: filepath.Join(root, "journal")})
	if err != nil {
		t.Fatalf("NewConsoleFileStore() error = %v", err)
	}
	topicID := daemonruntime.AgentLinkTopicID("inst_0123456789abcdef0123456789abcdef")
	for i, tc := range []struct {
		peer         string
		wantTitle    string
		wantRevision uint64
	}{
		{"Morph-2", "Morph-2", 0},
		{"Morph-2", "Morph-2", 0}, // the same name leaves the title alone
		{"Morph Two", "Morph Two", 1},
		{"", "Morph Two", 1}, // an unknown name keeps the last one
	} {
		info := daemonruntime.TaskInfo{ID: "task_" + string(rune('a'+i)), Status: daemonruntime.TaskQueued, Task: "hi", CreatedAt: time.Now().UTC(), TopicID: topicID}
		if err := recordAgentTask(store, info, daemonruntime.TaskTrigger{Source: mode, Event: "message"}, tc.peer); err != nil {
			t.Fatalf("recordAgentTask(%q) error = %v", tc.peer, err)
		}
		topic, ok := store.GetTopic(topicID)
		if !ok || topic.Title != tc.wantTitle || topic.TitleRevision != tc.wantRevision {
			t.Fatalf("after %q: topic = %#v, want title %q revision %d", tc.peer, topic, tc.wantTitle, tc.wantRevision)
		}
	}

	plain := daemonruntime.NewMemoryStore(10)
	info := daemonruntime.TaskInfo{ID: "task_plain", Status: daemonruntime.TaskQueued, Task: "hi", TopicID: topicID}
	if err := recordAgentTask(plain, info, daemonruntime.TaskTrigger{Source: mode}, "Morph-2"); err != nil {
		t.Fatalf("recordAgentTask(store without topics) error = %v", err)
	}
	if got, ok := plain.Get("task_plain"); !ok || got.TopicID != topicID {
		t.Fatalf("task in a store without topics = %#v, %v", got, ok)
	}
}

func TestNameAgentTopicsFillsOnlyMissingTitles(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{RootDir: root, Persist: true, JournalDir: filepath.Join(root, "journal")})
	if err != nil {
		t.Fatalf("NewConsoleFileStore() error = %v", err)
	}
	contactsStore := contacts.NewFileStore(filepath.Join(root, "contacts"))
	const untitled = "inst_0123456789abcdef0123456789abcdef"
	const titled = "inst_fedcba9876543210fedcba9876543210"
	for _, tc := range []struct{ instance, nickname, topicTitle string }{
		{untitled, "Morph-2", ""},
		{titled, "Morph-3", "Kept"},
	} {
		if err := contactsStore.PutContact(ctx, contacts.Contact{ContactID: "mm:" + tc.instance, Kind: contacts.KindAgent, ContactNickname: tc.nickname}); err != nil {
			t.Fatalf("PutContact() error = %v", err)
		}
		info := daemonruntime.TaskInfo{ID: "task_" + tc.instance, Status: daemonruntime.TaskDone, Task: "hi", TopicID: daemonruntime.AgentLinkTopicID(tc.instance)}
		if err := store.UpsertWithTrigger(info, daemonruntime.TaskTrigger{Source: mode}, tc.topicTitle); err != nil {
			t.Fatalf("UpsertWithTrigger() error = %v", err)
		}
	}

	nameAgentTopics(ctx, store, contactsStore, slog.New(slog.NewTextHandler(io.Discard, nil)))

	for instance, want := range map[string]string{untitled: "Morph-2", titled: "Kept"} {
		topic, ok := store.GetTopic(daemonruntime.AgentLinkTopicID(instance))
		if !ok || topic.Title != want {
			t.Fatalf("topic of %s = %#v, want title %q", instance, topic, want)
		}
	}
}

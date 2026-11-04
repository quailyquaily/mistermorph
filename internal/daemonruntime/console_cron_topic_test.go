package daemonruntime

import (
	"testing"
	"time"
)

func TestConsoleStoreKeepsATopicPerTodoItem(t *testing.T) {
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	topicID := CronTopicID(" task-4 ")
	if topicID != "_cron_task-4" || !IsCronTopicID(topicID) || IsCronTopicID(CronTopicPrefix) || !IsReservedTopicID(topicID) {
		t.Fatalf("cron topic ID helpers: %q", topicID)
	}
	now := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	run := func(id, title string) {
		t.Helper()
		info := TaskInfo{ID: id, Status: TaskRunning, Task: "Run.", CreatedAt: now, TopicID: topicID}
		if err := store.UpsertWithTrigger(info, TaskTrigger{Source: "cron"}, title); err != nil {
			t.Fatal(err)
		}
	}
	run("cron:1", "Morph build")
	topic, ok := store.GetTopic(topicID)
	if !ok || topic.Title != "Morph build" {
		t.Fatalf("topic = %+v", topic)
	}
	revision := topic.TitleRevision
	// The next run with the same title leaves the title alone; a renamed item renames its topic.
	run("cron:2", "Morph build")
	if topic, _ = store.GetTopic(topicID); topic.TitleRevision != revision {
		t.Fatalf("same title bumped the revision: %d -> %d", revision, topic.TitleRevision)
	}
	run("cron:3", "Morph nightly build")
	if topic, _ = store.GetTopic(topicID); topic.Title != "Morph nightly build" {
		t.Fatalf("renamed topic = %q", topic.Title)
	}
	// The item's runs are listed in its topic, not with the person's own tasks.
	if got := store.List(TaskListOptions{TopicID: topicID, Limit: 10}); len(got) != 3 {
		t.Fatalf("topic tasks = %d", len(got))
	}
	if got := store.List(TaskListOptions{Limit: 10}); len(got) != 0 {
		t.Fatalf("unfiltered list includes cron runs: %+v", got)
	}
	// The topic stays for the item's next run.
	if deleted, err := store.DeleteTopic(topicID); err != nil || deleted {
		t.Fatalf("DeleteTopic = %v, %v", deleted, err)
	}
	run("cron:4", "Morph nightly build")
}

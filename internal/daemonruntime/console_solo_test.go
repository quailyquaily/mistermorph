package daemonruntime

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSoloTopicIsMadeOnceAndKept(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: root, JournalDir: filepath.Join(root, "journal"), Persist: true}
	store, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.GetTopic(ConsoleSoloTopicID); ok {
		t.Fatal("Solo exists before its first use")
	}
	first, err := store.EnsureSoloTopic()
	if err != nil || first.ID != ConsoleSoloTopicID || first.Title != ConsoleSoloTopicTitle {
		t.Fatalf("EnsureSoloTopic() = %+v, %v", first, err)
	}
	again, err := store.EnsureSoloTopic()
	if err != nil || again.CreatedAt != first.CreatedAt {
		t.Fatalf("second EnsureSoloTopic() = %+v, %v", again, err)
	}
	if deleted, err := store.DeleteTopic(ConsoleSoloTopicID); deleted || err != nil {
		t.Fatalf("DeleteTopic(Solo) = %v, %v", deleted, err)
	}
	if _, err := store.RenameTopic(ConsoleSoloTopicID, "Mine"); err == nil {
		t.Fatal("Solo was renamed")
	}
	if !IsReservedTopicID(ConsoleSoloTopicID) || TopicRenamable(ConsoleSoloTopicID) || !IsSoloTopicID(" _solo ") {
		t.Fatal("Solo is not reserved")
	}
	thread, err := store.CreateThreadTopic("Build report", ConsoleSoloTopicID)
	if err != nil || !thread.TitleCustomized || thread.StartedFrom != ConsoleSoloTopicID {
		t.Fatalf("CreateThreadTopic() = %+v, %v", thread, err)
	}
	reloaded, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	solo, ok := reloaded.GetTopic(ConsoleSoloTopicID)
	if !ok || solo.Title != ConsoleSoloTopicTitle || solo.DeletedAt != nil {
		t.Fatalf("reloaded Solo = %+v", solo)
	}
	got, _ := reloaded.GetTopic(thread.ID)
	if got.StartedFrom != ConsoleSoloTopicID || got.Title != "Build report" {
		t.Fatalf("reloaded thread = %+v", got)
	}
	topics := 0
	for _, topic := range reloaded.ListTopicsPage(TopicListOptions{Limit: 10}) {
		if topic.ID == ConsoleSoloTopicID {
			topics++
		}
	}
	if topics != 1 {
		t.Fatalf("Solo listed %d times", topics)
	}
}

func TestSoloRecordIDsAndStates(t *testing.T) {
	if SoloThreadTaskIDFromCard(SoloThreadCardID("t1")) != "t1" || SoloThreadTaskIDFromCard(SoloThreadSummaryID("t1")) != "" {
		t.Fatal("card ids")
	}
	for status, want := range map[TaskStatus]string{
		TaskQueued: SoloThreadRunning, TaskRunning: SoloThreadRunning, TaskPending: SoloThreadWaiting,
		TaskDone: SoloThreadDone, TaskFailed: SoloThreadFailed, TaskCanceled: SoloThreadCanceled,
	} {
		if got := SoloThreadStateOf(status); got != want {
			t.Fatalf("SoloThreadStateOf(%s) = %s, want %s", status, got, want)
		}
	}
	if SoloThreadStateEnded(SoloThreadWaiting) || !SoloThreadStateEnded(SoloThreadCanceled) {
		t.Fatal("ended states")
	}
}

// An edit in Solo drops the edited message and the later messages, but not the cards and
// summaries of the work threads: the threads run on, and their cards are the way to them.
func TestSoloEditKeepsWorkThreadRecords(t *testing.T) {
	root := t.TempDir()
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{RootDir: root, JournalDir: filepath.Join(root, "journal"), Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnsureSoloTopic(); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-time.Hour)
	put := func(topicID, id, text string, minute int) {
		t.Helper()
		at := start.Add(time.Duration(minute) * time.Minute)
		if err := store.Upsert(TaskInfo{ID: id, TopicID: topicID, Task: text, Status: TaskDone, CreatedAt: at, FinishedAt: &at}); err != nil {
			t.Fatal(err)
		}
	}
	put(ConsoleSoloTopicID, "m0", "hello", 0)
	put(ConsoleSoloTopicID, "m1", "migrate the db", 1)
	put(ConsoleSoloTopicID, SoloThreadCardID("th1"), "", 2)
	put(ConsoleSoloTopicID, SoloThreadSummaryID("th1"), "", 3)
	put(ConsoleSoloTopicID, "m2", "thanks", 4)

	now := time.Now().UTC()
	removed, err := store.ReplaceTopicTasks("m1", TaskInfo{ID: "m1b", TopicID: ConsoleSoloTopicID, Task: "migrate the test db", Status: TaskQueued, CreatedAt: now}, TaskTrigger{Source: "ui", Event: "chat_edit"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(removed, ",") != "m2,m1" {
		t.Fatalf("removed = %v", removed)
	}
	for _, id := range []string{"m0", SoloThreadCardID("th1"), SoloThreadSummaryID("th1"), "m1b"} {
		if _, ok := store.Get(id); !ok {
			t.Fatalf("%s is gone", id)
		}
	}
	// Elsewhere an edit drops everything after the message, whatever its ID.
	topic, err := store.CreateTopic("Other")
	if err != nil {
		t.Fatal(err)
	}
	put(topic.ID, "o1", "first", 10)
	put(topic.ID, SoloThreadCardID("x"), "look-alike", 11)
	removed, err = store.ReplaceTopicTasks("o1", TaskInfo{ID: "o1b", TopicID: topic.ID, Task: "first again", Status: TaskQueued, CreatedAt: now}, TaskTrigger{Source: "ui", Event: "chat_edit"})
	if err != nil || len(removed) != 2 {
		t.Fatalf("removed = %v, %v", removed, err)
	}
	// The kept records survive a reload of the journal too.
	reloaded, err := NewConsoleFileStore(ConsoleFileStoreOptions{RootDir: root, JournalDir: filepath.Join(root, "journal"), Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reloaded.Get(SoloThreadCardID("th1")); !ok {
		t.Fatal("the card is gone after a reload")
	}
	if _, ok := reloaded.Get("m2"); ok {
		t.Fatal("m2 is back after a reload")
	}
}

package daemonruntime

import (
	"path/filepath"
	"testing"
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

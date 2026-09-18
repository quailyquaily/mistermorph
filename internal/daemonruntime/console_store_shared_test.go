package daemonruntime

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestConsoleStorePreservesLiveChatAndRecoversExitedChat(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: filepath.Join(root, "console"), JournalDir: filepath.Join(root, "journal"), Persist: true, SkipRecovery: true}
	chat, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	owner, release, err := chat.AcquireChatSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if release != nil {
			release()
		}
	}()
	if err := chat.UpsertWithTrigger(TaskInfo{ID: "chat-running", TopicID: "shared", Status: TaskRunning, CreatedAt: time.Now().UTC()}, TaskTrigger{Source: "chat", Ref: owner}, "shared"); err != nil {
		t.Fatal(err)
	}
	opts.SkipRecovery = false
	web, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := web.Get("chat-running"); got == nil || got.Status != TaskRunning {
		t.Fatalf("opening Web canceled live chat: %+v", got)
	}
	if err := web.UpsertWithTrigger(TaskInfo{ID: "web-conflict", TopicID: "shared", Status: TaskQueued, CreatedAt: time.Now().UTC()}, TaskTrigger{Source: "ui"}, ""); !errors.Is(err, ErrTopicBusy) {
		t.Fatalf("Web accepted work in a locally running topic: %v", err)
	}
	if _, err := web.DeleteTopic("shared"); !errors.Is(err, ErrTopicBusy) {
		t.Fatalf("Web deleted a locally running topic: %v", err)
	}
	release()
	release = nil
	if got, _ := web.Get("chat-running"); got == nil || got.Status != TaskCanceled {
		t.Fatalf("Web must recover exited chat without restarting: %+v", got)
	}
	reopened, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := reopened.Get("chat-running"); got == nil || got.Status != TaskCanceled {
		t.Fatalf("exited chat was not recovered: %+v", got)
	}
}

func TestLocalChatStoreDoesNotRecoverConsoleTasks(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: filepath.Join(root, "console"), JournalDir: filepath.Join(root, "journal"), Persist: true}
	web, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := web.UpsertWithTrigger(TaskInfo{ID: "web-running", TopicID: "shared", Status: TaskRunning, CreatedAt: time.Now().UTC()}, TaskTrigger{Source: "ui"}, "shared"); err != nil {
		t.Fatal(err)
	}
	opts.SkipRecovery = true
	chat, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := chat.Get("web-running"); got == nil || got.Status != TaskRunning {
		t.Fatalf("opening chat canceled Web task: %+v", got)
	}
	if _, err := chat.DeleteTopic("shared"); !errors.Is(err, ErrTopicBusy) {
		t.Fatalf("chat deleted a running Web topic: %v", err)
	}
	if err := chat.UpsertWithTrigger(TaskInfo{ID: "chat-conflict", TopicID: "shared", Status: TaskRunning, CreatedAt: time.Now().UTC()}, TaskTrigger{Source: "chat"}, ""); !errors.Is(err, ErrTopicBusy) {
		t.Fatalf("chat accepted work in a Web running topic: %v", err)
	}
}

func TestConsoleStoresShareHistoryAndTopicChanges(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: filepath.Join(root, "console"), JournalDir: filepath.Join(root, "journal"), Persist: true}
	first, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	topic, err := first.CreateTopic("shared")
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := second.GetTopic(topic.ID); !ok || got.Title != topic.Title {
		t.Fatalf("second store cannot see new topic: %+v", got)
	}
	if err := first.Upsert(TaskInfo{ID: "chat-task", TopicID: topic.ID, Task: "from chat", Status: TaskDone, CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := second.SetTopicTitle(topic.ID, "renamed in Web"); err != nil {
		t.Fatal(err)
	}
	if err := second.Upsert(TaskInfo{ID: "web-task", TopicID: topic.ID, Task: "from Web", Status: TaskDone, CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	for _, store := range []*ConsoleFileStore{first, second} {
		if tasks := store.List(TaskListOptions{TopicID: topic.ID, Limit: 20}); len(tasks) != 2 {
			t.Fatalf("shared history has %d tasks, want 2", len(tasks))
		}
		if got, _ := store.GetTopic(topic.ID); got == nil || got.Title != "renamed in Web" {
			t.Fatalf("topic rename was lost: %+v", got)
		}
	}
	if _, err := second.DeleteTopic(topic.ID); err != nil {
		t.Fatal(err)
	}
	if topics := first.ListTopicsPage(TopicListOptions{Limit: 20}); len(topics) != 0 {
		t.Fatalf("deleted topic still visible: %+v", topics)
	}
	if tasks := first.List(TaskListOptions{TopicID: topic.ID, Limit: 20}); len(tasks) != 0 {
		t.Fatalf("deleted topic history still visible: %+v", tasks)
	}
	if err := first.Upsert(TaskInfo{ID: "late-submit", TopicID: topic.ID, Status: TaskRunning, CreatedAt: time.Now().UTC()}); err == nil {
		t.Fatal("accepted task after another process deleted the topic")
	}
}

func TestConsoleStoresSerializeConcurrentUpdates(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: filepath.Join(root, "console"), JournalDir: filepath.Join(root, "journal"), Persist: true}
	var stores []*ConsoleFileStore
	for range 4 {
		store, err := NewConsoleFileStore(opts)
		if err != nil {
			t.Fatal(err)
		}
		stores = append(stores, store)
	}
	if err := stores[0].Upsert(TaskInfo{ID: "counter", Status: TaskDone, Task: "", CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i, store := range stores {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range 10 {
				if err := store.Update("counter", func(info *TaskInfo) { info.Task += "x" }); err != nil {
					t.Error(err)
				}
				if err := store.Upsert(TaskInfo{ID: fmt.Sprintf("task-%d-%d", i, j), Status: TaskDone, CreatedAt: time.Now().UTC()}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	reopened, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := reopened.Get("counter"); !ok || len(got.Task) != 40 {
		t.Fatalf("concurrent updates were lost: %+v", got)
	}
	if got := reopened.List(TaskListOptions{Limit: 100}); len(got) != 41 {
		t.Fatalf("concurrent appends were lost: %d tasks", len(got))
	}
}

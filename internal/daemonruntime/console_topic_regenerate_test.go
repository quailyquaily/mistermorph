package daemonruntime

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func TestRegenerateTopicTitlePreservesConcurrentChanges(t *testing.T) {
	for _, mode := range []string{"success", "manual", "manual-same-title", "submitted-title", "deleted", "newer-request", "task-update"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			opts := ConsoleFileStoreOptions{RootDir: root, JournalDir: filepath.Join(root, "journal"), Persist: true}
			store, err := NewConsoleFileStore(opts)
			if err != nil {
				t.Fatal(err)
			}
			topic, err := store.CreateTopic("seed")
			if err != nil {
				t.Fatal(err)
			}
			if err := store.SetTopicTitle(topic.ID, "mine"); err != nil {
				t.Fatal(err)
			}
			before, _ := store.GetTopic(topic.ID)
			started, err := store.BeginTopicTitleRegeneration(topic.ID)
			if err != nil {
				t.Fatal(err)
			}
			if started.Title != before.Title || started.Icon != before.Icon || !started.UpdatedAt.Equal(before.UpdatedAt) {
				t.Fatalf("start changed visible metadata: %+v", started)
			}
			switch mode {
			case "manual":
				err = store.SetTopicTitle(topic.ID, "new manual title")
			case "manual-same-title":
				err = store.SetTopicTitle(topic.ID, "mine")
			case "submitted-title":
				err = store.UpsertWithTrigger(TaskInfo{ID: "task", TopicID: topic.ID, Task: "follow up"}, TaskTrigger{}, "new manual title")
			case "deleted":
				_, err = store.DeleteTopic(topic.ID)
			case "newer-request":
				_, err = store.BeginTopicTitleRegeneration(topic.ID)
			case "task-update":
				err = store.Upsert(TaskInfo{ID: "task", TopicID: topic.ID, Task: "more discussion"})
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = store.CompleteTopicTitleRegeneration(topic.ID, started.TitleRevision, "generated", "baby")
			wantSuccess := mode == "success" || mode == "task-update"
			if wantSuccess && err != nil {
				t.Fatal(err)
			}
			if !wantSuccess && !errors.Is(err, ErrTopicTitleChanged) {
				t.Fatalf("error = %v", err)
			}
			reloaded, err := NewConsoleFileStore(opts)
			if err != nil {
				t.Fatal(err)
			}
			got, _ := reloaded.GetTopic(topic.ID)
			if wantSuccess && (got.Title != "generated" || got.Icon != "baby" || got.TitleCustomized || got.LLMTitleGeneratedAt == nil) {
				t.Fatalf("topic = %+v", got)
			}
			if !wantSuccess && got.Title == "generated" {
				t.Fatalf("concurrent change overwritten: %+v", got)
			}
		})
	}
}

func TestRegenerationInvalidatesInitialNamingEvenWhenItFails(t *testing.T) {
	store, _ := NewConsoleFileStore(ConsoleFileStoreOptions{})
	topic, _ := store.CreateTopic("seed")
	if _, err := store.BeginTopicTitleRegeneration(topic.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.SetTopicTitleFromLLM(topic.ID, "seed", "late auto name", "code"); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetTopic(topic.ID)
	if got.Title != "seed" || got.Icon != "" || got.LLMTitleGeneratedAt != nil {
		t.Fatalf("topic = %+v", got)
	}
}

func TestTopicTitleTasksSelectsFirstAndRecentConversation(t *testing.T) {
	store, _ := NewConsoleFileStore(ConsoleFileStoreOptions{})
	topic, _ := store.CreateTopic("seed")
	for i := 0; i < 20; i++ {
		text := fmt.Sprintf("question %d", i)
		if i == 0 || i == 19 {
			text = "/ctx compact"
		}
		if err := store.Upsert(TaskInfo{ID: fmt.Sprint(i), TopicID: topic.ID, Task: text, CreatedAt: time.Unix(int64(i), 0)}); err != nil {
			t.Fatal(err)
		}
	}
	tasks := store.TopicTitleTasks(topic.ID, 6)
	if len(tasks) != 7 || tasks[0].Task != "question 1" || tasks[1].Task != "question 13" || tasks[6].Task != "question 18" {
		t.Fatalf("tasks = %+v", tasks)
	}
	if _, err := store.DeleteTopic(topic.ID); err != nil {
		t.Fatal(err)
	}
	if len(store.TopicTitleTasks(topic.ID, 6)) != 0 {
		t.Fatal("read deleted topic")
	}
}

func TestCronTopicRegenerationChangesOnlyTheIcon(t *testing.T) {
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	topicID := CronTopicID("weekly")
	if err := store.UpsertWithTrigger(TaskInfo{ID: "run", TopicID: topicID, Task: "report"}, TaskTrigger{}, "Weekly report"); err != nil {
		t.Fatal(err)
	}
	before, _ := store.GetTopic(topicID)
	started, err := store.BeginTopicTitleRegeneration(topicID)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := store.CompleteTopicTitleRegeneration(topicID, started.TitleRevision, "A generated name", "code")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Icon != "code" || updated.LLMTitleGeneratedAt == nil {
		t.Fatalf("icon not applied: %+v", updated)
	}
	if updated.Title != "Weekly report" {
		t.Fatalf("title = %q, want the item's", updated.Title)
	}
	if !updated.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatal("regenerating the icon moved the topic in the list, which the latest run orders")
	}
}

func TestSetCronTopicIconFromLLM(t *testing.T) {
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	topicID := CronTopicID("weekly")
	if err := store.UpsertWithTrigger(TaskInfo{ID: "run", TopicID: topicID, Task: "report"}, TaskTrigger{}, "Weekly report"); err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert(TaskInfo{ID: "chat", TopicID: "topic_a", Task: "hello"}); err != nil {
		t.Fatal(err)
	}
	before, _ := store.GetTopic(topicID)
	if err := store.SetCronTopicIconFromLLM(topicID, "code"); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetTopic(topicID)
	if got.Icon != "code" || got.LLMTitleGeneratedAt == nil || got.Title != "Weekly report" || !got.UpdatedAt.Equal(before.UpdatedAt) || got.TitleRevision <= before.TitleRevision {
		t.Fatalf("topic = %+v, before = %+v", got, before)
	}
	// Only the first generated icon lands: a regeneration may have got there first.
	if err := store.SetCronTopicIconFromLLM(topicID, "chat"); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetTopic(topicID); got.Icon != "code" {
		t.Fatalf("icon = %q, want it kept", got.Icon)
	}
	// Any other topic is left alone.
	if err := store.SetCronTopicIconFromLLM("topic_a", "code"); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetTopic("topic_a"); got.Icon == "code" || got.LLMTitleGeneratedAt != nil {
		t.Fatalf("person's topic changed: %+v", got)
	}
}

func TestSetCronTopicRunModelSurvivesARestart(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: root, JournalDir: filepath.Join(root, "journal"), Persist: true}
	store, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	topicID := CronTopicID("weekly")
	if err := store.UpsertWithTrigger(TaskInfo{ID: "run", TopicID: topicID, Task: "report"}, TaskTrigger{}, "Weekly report"); err != nil {
		t.Fatal(err)
	}
	before, _ := store.GetTopic(topicID)
	if err := store.SetCronTopicRunModel(topicID, "openai", "gpt-5.2"); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := reopened.GetTopic(topicID)
	if !ok || got.LLMProvider != "openai" || got.LLMModel != "gpt-5.2" || got.Title != "Weekly report" || !got.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("topic = %+v, before = %+v", got, before)
	}
	// Only a TODO item's topic takes it.
	if err := store.Upsert(TaskInfo{ID: "chat", TopicID: "topic_a", Task: "hello"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetCronTopicRunModel("topic_a", "openai", "gpt-5.2"); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetTopic("topic_a"); got.LLMModel != "" {
		t.Fatalf("person's topic changed: %+v", got)
	}
}

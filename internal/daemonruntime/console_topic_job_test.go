package daemonruntime

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/topicproj"
)

// A job's topic names its job in job_id. The topic keeps its own ID, each run keeps its own task
// ID, and the job's ID is only the link between them.
func TestJobTopicLinksItsJobAndKeepsRunsApart(t *testing.T) {
	root := t.TempDir()
	journalDir := filepath.Join(root, "journal")
	projPath := filepath.Join(root, "stats", "topics_projection.json")
	open := func() *ConsoleFileStore {
		t.Helper()
		store, err := NewConsoleFileStore(ConsoleFileStoreOptions{RootDir: root, Persist: true, JournalDir: journalDir, TopicsProjectionPath: projPath})
		if err != nil {
			t.Fatal(err)
		}
		return store
	}
	store := open()
	const jobID = "job-0b7e5d1c-2f7a-4c2e-9a51-1d2f3e4a5b6c"
	topicID := CronTopicID(jobID)
	now := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	trigger := TaskTrigger{Source: "cron", Event: CronRunTriggerEvent, Ref: CronRunTriggerRefSchedule}
	for i, runID := range []string{"run-1", "run-2"} {
		info := TaskInfo{ID: runID, Status: TaskDone, Task: "Send the report.", CreatedAt: now.Add(time.Duration(i) * time.Hour), TopicID: topicID}
		if err := store.UpsertWithTrigger(info, trigger, "Weekly report"); err != nil {
			t.Fatal(err)
		}
	}
	// A person's own topic names no job.
	own, err := store.CreateTopic("Plans")
	if err != nil || own.JobID != "" {
		t.Fatalf("own topic = %+v, %v", own, err)
	}

	check := func(store *ConsoleFileStore) {
		t.Helper()
		topic, ok := store.GetTopic(topicID)
		if !ok || topic.ID != topicID || topic.JobID != jobID {
			t.Fatalf("topic = %+v", topic)
		}
		runs := store.List(TaskListOptions{TopicID: topicID, Limit: 10})
		if len(runs) != 2 || runs[0].ID == runs[1].ID {
			t.Fatalf("runs = %+v", runs)
		}
		for _, run := range runs {
			if run.ID == jobID || run.ID == topicID || run.TopicID != topicID {
				t.Fatalf("run identity mixed with the job's or topic's: %+v", run)
			}
		}
		if got, _ := store.GetTopic(own.ID); got.JobID != "" {
			t.Fatalf("own topic after reload = %+v", got)
		}
		data, _ := json.Marshal(topic)
		var wire map[string]any
		_ = json.Unmarshal(data, &wire)
		if wire["job_id"] != jobID || wire["id"] != topicID {
			t.Fatalf("topic JSON = %s", data)
		}
	}
	check(store)
	check(open())

	// The topics projection local clients read carries the link too.
	proj, ok, err := topicproj.Load(projPath)
	if err != nil || !ok {
		t.Fatalf("projection: %v, %v", ok, err)
	}
	found := false
	for _, item := range proj.Items {
		if item.ID == topicID {
			found = item.JobID == jobID
		}
	}
	if !found {
		t.Fatalf("projection items = %+v", proj.Items)
	}
}

// A topic recorded before topics named their job gets the link from its ID on load, and a link
// that was recorded is kept as it is, whatever the topic's ID.
func TestJobTopicLinkOfLegacyAndExplicitTopics(t *testing.T) {
	root := t.TempDir()
	journalDir := filepath.Join(root, "journal")
	journal, err := taskdomain.NewJournal(journalDir, 0)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	legacy := TopicInfo{ID: "_cron_task-3", Title: "Old item", CreatedAt: now, UpdatedAt: now}
	explicit := TopicInfo{ID: "topic-from-a-webhook", Title: "Hook", JobID: "job-11111111-2222-4333-8444-555555555555", CreatedAt: now, UpdatedAt: now}
	for _, topic := range []TopicInfo{legacy, explicit} {
		topic := topic
		if _, err := taskdomain.AppendJournalEvent(journal, "console", taskdomain.JournalTypeTopicUpsert, now, TaskTrigger{}, nil, &topic); err != nil {
			t.Fatal(err)
		}
	}
	_ = journal.Close()
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{RootDir: root, Persist: true, JournalDir: journalDir})
	if err != nil {
		t.Fatal(err)
	}
	if topic, ok := store.GetTopic("_cron_task-3"); !ok || topic.JobID != "task-3" || topic.ID != "_cron_task-3" {
		t.Fatalf("legacy topic = %+v", topic)
	}
	if topic, ok := store.GetTopic("topic-from-a-webhook"); !ok || topic.JobID != explicit.JobID {
		t.Fatalf("explicit topic = %+v", topic)
	}
	if CronTopicJobID("_cron_") != "" || CronTopicJobID("default") != "" || CronTopicJobID(" _cron_job-1 ") != "job-1" {
		t.Fatal("CronTopicJobID")
	}
}

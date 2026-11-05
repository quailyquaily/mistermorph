package daemonruntime

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/spf13/viper"
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

// Saving a renamed item renames its topic at once: an item that is off has no next run to do it.
func TestSavingATodoItemRenamesItsTopic(t *testing.T) {
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	info := TaskInfo{ID: "cron:1", Status: TaskDone, Task: "Run.", CreatedAt: now, TopicID: CronTopicID("weekly")}
	if err := store.UpsertWithTrigger(info, TaskTrigger{Source: "cron"}, "Weekly report"); err != nil {
		t.Fatal(err)
	}
	before, _ := store.GetTopic("_cron_weekly")

	stateDir := t.TempDir()
	settings := viper.New()
	settings.Set("file_state_dir", stateDir)
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode: "console", AuthToken: "token", AgentSettingsReader: settings, RuntimePaths: testRuntimePaths(stateDir),
		TaskTopic: TaskTopicRoutes{TopicReader: store},
	})
	save := func(body string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/todo/tasks", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("PUT status %d (%s)", rec.Code, rec.Body.String())
		}
	}
	// The renamed item is off, and "fresh" has not run, so it has no topic to rename.
	save(`{"tasks":[{"id":"weekly","title":" Monthly report ","enabled":false,"cron":"0 10 * * 1","tz":"UTC","content":"Report."},{"id":"fresh","title":"Fresh","cron":"0 9 * * *","tz":"UTC","content":"Run."}]}`)
	after, _ := store.GetTopic("_cron_weekly")
	if after.Title != "Monthly report" || after.TitleRevision != before.TitleRevision+1 {
		t.Fatalf("topic after the rename = %+v", after)
	}
	// The list of TODO topics is ordered by the latest run, which a rename is not.
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("rename moved the topic: %v -> %v", before.UpdatedAt, after.UpdatedAt)
	}
	if _, ok := store.GetTopic("_cron_fresh"); ok {
		t.Fatalf("saving made a topic for an item that has not run")
	}
	// Saving again changes nothing, and an untitled item's topic takes the default title.
	save(`{"tasks":[{"id":"weekly","title":"Monthly report","enabled":false,"cron":"0 10 * * 1","tz":"UTC","content":"Report."}]}`)
	if same, _ := store.GetTopic("_cron_weekly"); same.TitleRevision != after.TitleRevision {
		t.Fatalf("same title bumped the revision: %d -> %d", after.TitleRevision, same.TitleRevision)
	}
	save(`{"tasks":[{"id":"weekly","enabled":false,"cron":"0 10 * * 1","tz":"UTC","content":"Report."}]}`)
	if untitled, _ := store.GetTopic("_cron_weekly"); untitled.Title != "Unititled TODO" {
		t.Fatalf("untitled item's topic = %q", untitled.Title)
	}
}

package daemonruntime

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/topicproj"
)

func TestConsoleFileStoreTopicsProjection(t *testing.T) {
	root := t.TempDir()
	journalDir := filepath.Join(root, "journal")
	projPath := filepath.Join(root, "stats", "topics_projection.json")

	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{
		RootDir:              root,
		Persist:              true,
		JournalDir:           journalDir,
		TopicsProjectionPath: projPath,
	})
	if err != nil {
		t.Fatalf("NewConsoleFileStore() error = %v", err)
	}

	created, err := store.CreateTopic("First topic")
	if err != nil {
		t.Fatalf("CreateTopic() error = %v", err)
	}

	proj, ok, err := topicproj.Load(projPath)
	if err != nil {
		t.Fatalf("topicproj.Load() error = %v", err)
	}
	if !ok {
		t.Fatal("topic projection not written after CreateTopic")
	}
	if len(proj.Items) != 1 || proj.Items[0].ID != created.ID {
		t.Fatalf("projection items = %+v, want only topic %q", proj.Items, created.ID)
	}
	if proj.Items[0].Title != "First topic" {
		t.Fatalf("projection title = %q, want %q", proj.Items[0].Title, "First topic")
	}

	if err := store.SetTopicTitle(created.ID, "Renamed topic"); err != nil {
		t.Fatalf("SetTopicTitle() error = %v", err)
	}
	proj, ok, err = topicproj.Load(projPath)
	if err != nil || !ok {
		t.Fatalf("topicproj.Load() after rename ok = %v, error = %v", ok, err)
	}
	if proj.Items[0].Title != "Renamed topic" {
		t.Fatalf("projection title after rename = %q", proj.Items[0].Title)
	}

	if _, err := store.DeleteTopic(created.ID); err != nil {
		t.Fatalf("DeleteTopic() error = %v", err)
	}
	proj, ok, err = topicproj.Load(projPath)
	if err != nil || !ok {
		t.Fatalf("topicproj.Load() after delete ok = %v, error = %v", ok, err)
	}
	if len(proj.Items) != 0 {
		t.Fatalf("projection items after delete = %+v, want none", proj.Items)
	}

	// A reload rewrites the projection from the replayed journal state.
	if _, err := NewConsoleFileStore(ConsoleFileStoreOptions{
		RootDir:              root,
		Persist:              true,
		JournalDir:           journalDir,
		TopicsProjectionPath: projPath,
	}); err != nil {
		t.Fatalf("reload NewConsoleFileStore() error = %v", err)
	}
	proj, ok, err = topicproj.Load(projPath)
	if err != nil || !ok {
		t.Fatalf("topicproj.Load() after reload ok = %v, error = %v", ok, err)
	}
	if len(proj.Items) != 0 {
		t.Fatalf("projection items after reload = %+v, want none", proj.Items)
	}
}

func TestConsoleFileStoreUpsertWritesTopicsProjection(t *testing.T) {
	root := t.TempDir()
	journalDir := filepath.Join(root, "journal")
	projPath := filepath.Join(root, "stats", "topics_projection.json")

	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{
		RootDir:              root,
		Persist:              true,
		JournalDir:           journalDir,
		TopicsProjectionPath: projPath,
	})
	if err != nil {
		t.Fatalf("NewConsoleFileStore() error = %v", err)
	}

	now := time.Now().UTC()
	if err := store.UpsertWithTrigger(TaskInfo{
		ID:        "task_1",
		Status:    TaskDone,
		Task:      "hello",
		CreatedAt: now,
	}, TaskTrigger{}, "Auto title"); err != nil {
		t.Fatalf("UpsertWithTrigger() error = %v", err)
	}
	proj, ok, err := topicproj.Load(projPath)
	if err != nil || !ok {
		t.Fatalf("topicproj.Load() ok = %v, error = %v", ok, err)
	}
	if len(proj.Items) != 1 || proj.Items[0].Title != "Auto title" {
		t.Fatalf("projection items = %+v, want one topic titled %q", proj.Items, "Auto title")
	}
}

func TestConsoleFileStoreWithoutTopicsProjectionPathWritesNothing(t *testing.T) {
	root := t.TempDir()
	journalDir := filepath.Join(root, "journal")
	projPath := filepath.Join(root, "stats", "topics_projection.json")

	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{
		RootDir:    root,
		Persist:    true,
		JournalDir: journalDir,
	})
	if err != nil {
		t.Fatalf("NewConsoleFileStore() error = %v", err)
	}
	if _, err := store.CreateTopic("Topic"); err != nil {
		t.Fatalf("CreateTopic() error = %v", err)
	}
	if _, err := os.Stat(projPath); !os.IsNotExist(err) {
		t.Fatalf("topics projection should not be written, stat error = %v", err)
	}
}

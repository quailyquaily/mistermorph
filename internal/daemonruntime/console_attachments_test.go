package daemonruntime

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type brokenAttachmentReader struct{}

func (brokenAttachmentReader) Read([]byte) (int, error) { return 0, errors.New("read failure") }

func TestConsoleAttachmentStorageFailures(t *testing.T) {
	for _, failure := range []string{"read", "storage", "journal"} {
		t.Run(failure, func(t *testing.T) {
			root := t.TempDir()
			store, err := NewConsoleFileStore(ConsoleFileStoreOptions{RootDir: root, JournalDir: filepath.Join(root, "journal"), Persist: true})
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Upsert(TaskInfo{ID: "task", TopicID: "topic", Status: TaskDone}); err != nil {
				t.Fatal(err)
			}
			var source io.Reader = strings.NewReader("content")
			switch failure {
			case "read":
				source = brokenAttachmentReader{}
			case "storage":
				if err := os.WriteFile(filepath.Join(root, "attachments"), []byte("blocked"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "journal":
				// Preserve journal replay while rejecting the append after content is copied.
				if err := store.journal.Close(); err != nil {
					t.Fatal(err)
				}
			}
			attachment, err := store.AddAttachment("task", "topic", "report.txt", source)
			if err == nil || attachment.ID != "" {
				t.Fatalf("failure reported success: %+v %v", attachment, err)
			}
			if len(store.items["task"].Attachments) != 0 {
				t.Fatal("failure published metadata")
			}
			if failure != "storage" {
				entries, _ := os.ReadDir(filepath.Join(root, "attachments"))
				if len(entries) != 0 {
					t.Fatal("failure retained orphaned content")
				}
			}
		})
	}
}

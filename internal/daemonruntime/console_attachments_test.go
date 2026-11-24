package daemonruntime

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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

func attachmentPreviewStore(t *testing.T) *ConsoleFileStore {
	t.Helper()
	root := t.TempDir()
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{RootDir: root, JournalDir: filepath.Join(root, "journal"), Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert(TaskInfo{ID: "task", TopicID: "topic", Status: TaskDone}); err != nil {
		t.Fatal(err)
	}
	return store
}

func serveAttachmentPreview(store *ConsoleFileStore, topicID, taskID, id string, preview bool) *httptest.ResponseRecorder {
	query := url.Values{"topic_id": {topicID}, "task_id": {taskID}, "id": {id}}
	if preview {
		query.Set("preview", "1")
	}
	rec := httptest.NewRecorder()
	store.ServeAttachment(rec, httptest.NewRequest(http.MethodGet, "/attachments?"+query.Encode(), nil))
	return rec
}

func TestConsoleAttachmentPreviewTypes(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 32)...)
	pdf := []byte("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n")
	zip := append([]byte("PK\x03\x04"), bytes.Repeat([]byte{0, 1, 2, 0xff}, 16)...)
	bigText := bytes.Repeat([]byte("a"), int(attachmentTextPreviewMaxBytes)+1)
	capText := bytes.Repeat([]byte("é"), int(attachmentTextPreviewMaxBytes)/2)
	for _, test := range []struct {
		name, file string
		content    []byte
		recorded   string // the content type recorded when the file was sent
		status     int    // of the preview
		served     string // the preview's content type
	}{
		{"png", "image.dat", png, "image/png", 200, "image/png"},
		{"pdf", "report.pdf", pdf, "application/pdf", 200, "application/pdf"},
		{"pdf named otherwise", "report.bin", pdf, "application/pdf", 200, "application/pdf"},
		{"markdown", "notes.md", []byte("# Notes\n\n*hello* — ünïcode\n"), "text/plain; charset=utf-8", 200, "text/plain; charset=utf-8"},
		{"json", "data.json", []byte(`{"a":1}`), "text/plain; charset=utf-8", 200, "text/plain; charset=utf-8"},
		{"csv", "table.csv", []byte("a,b\n1,2\n"), "text/plain; charset=utf-8", 200, "text/plain; charset=utf-8"},
		{"log", "run.log", []byte("started\nended\n"), "text/plain; charset=utf-8", 200, "text/plain; charset=utf-8"},
		{"source", "main.go", []byte("package main\n"), "text/plain; charset=utf-8", 200, "text/plain; charset=utf-8"},
		{"script as text", "build.js", []byte("<script>alert(1)</script>"), "text/plain; charset=utf-8", 200, "text/plain; charset=utf-8"},
		{"name without extension", "Makefile", []byte("all:\n\tgo build\n"), "text/plain; charset=utf-8", 200, "text/plain; charset=utf-8"},
		{"text at the cap", "big.txt", capText, "text/plain; charset=utf-8", 200, "text/plain; charset=utf-8"},
		{"text over the cap", "big.txt", bigText, "application/octet-stream", 413, ""},
		{"invalid utf-8", "notes.txt", []byte{'o', 'k', 0xff, 0xfe}, "application/octet-stream", 400, ""},
		{"nul bytes", "notes.txt", []byte("a\x00b"), "application/octet-stream", 400, ""},
		{"zip", "archive.zip", zip, "application/octet-stream", 400, ""},
		{"binary", "program", []byte{0x7f, 'E', 'L', 'F', 0, 0, 1}, "application/octet-stream", 400, ""},
		{"html", "page.html", []byte("<html><script>alert(1)</script></html>"), "application/octet-stream", 400, ""},
		{"svg", "drawing.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`), "application/octet-stream", 400, ""},
		{"xml", "feed.xml", []byte(`<?xml version="1.0"?><a/>`), "application/octet-stream", 400, ""},
		{"fake pdf", "report.pdf", []byte("<svg onload=\"alert(1)\"/>"), "application/octet-stream", 400, ""},
		{"fake png", "fake.png", []byte("plain words"), "application/octet-stream", 400, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := attachmentPreviewStore(t)
			attachment, err := store.AddAttachment("task", "topic", test.file, bytes.NewReader(test.content))
			if err != nil {
				t.Fatal(err)
			}
			if attachment.ContentType != test.recorded {
				t.Fatalf("recorded type %q, want %q", attachment.ContentType, test.recorded)
			}
			rec := serveAttachmentPreview(store, "topic", "task", attachment.ID, true)
			if rec.Code != test.status {
				t.Fatalf("preview status %d, want %d: %s", rec.Code, test.status, rec.Body.String())
			}
			header := rec.Header()
			if header.Get("X-Content-Type-Options") != "nosniff" || header.Get("Cache-Control") != "private, no-store" ||
				header.Get("Content-Security-Policy") != "sandbox; default-src 'none'; frame-ancestors 'none'" {
				t.Fatalf("missing safe headers: %v", header)
			}
			if test.status == 200 {
				if header.Get("Content-Type") != test.served || header.Get("Content-Disposition") != "inline" {
					t.Fatalf("preview headers: %v", header)
				}
				if !bytes.Equal(rec.Body.Bytes(), test.content) {
					t.Fatal("preview changed the bytes")
				}
			} else if !strings.HasSuffix(strings.TrimSpace(rec.Body.String()), "download it instead") {
				t.Fatalf("a refused preview served something else: %.40q", rec.Body.String())
			}
			// The download is unchanged whatever the type.
			rec = serveAttachmentPreview(store, "topic", "task", attachment.ID, false)
			if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/octet-stream" ||
				!strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment;") || !bytes.Equal(rec.Body.Bytes(), test.content) {
				t.Fatalf("download: %d %v", rec.Code, rec.Header())
			}
		})
	}
}

// Files sent before text and PDF previews were recorded as application/octet-stream: their
// preview follows the bytes and the name.
func TestConsoleAttachmentPreviewLegacyMetadata(t *testing.T) {
	for _, test := range []struct {
		file    string
		content string
		status  int
		served  string
	}{
		{"report.pdf", "%PDF-1.4\n%%EOF\n", 200, "application/pdf"},
		{"notes.md", "# Notes\n", 200, "text/plain; charset=utf-8"},
		{"notes.md", "\xff\xfe", 400, ""},
		{"archive.tar", "data", 400, ""},
	} {
		t.Run(test.file, func(t *testing.T) {
			store := attachmentPreviewStore(t)
			attachment, err := store.AddAttachment("task", "topic", test.file, strings.NewReader(test.content))
			if err != nil {
				t.Fatal(err)
			}
			task := store.items["task"]
			task.Attachments[0].ContentType = "application/octet-stream"
			store.items["task"] = task
			rec := serveAttachmentPreview(store, "topic", "task", attachment.ID, true)
			if rec.Code != test.status || (test.served != "" && rec.Header().Get("Content-Type") != test.served) {
				t.Fatalf("preview: %d %v", rec.Code, rec.Header())
			}
		})
	}
}

func TestConsoleAttachmentPreviewAccess(t *testing.T) {
	store := attachmentPreviewStore(t)
	if err := store.Upsert(TaskInfo{ID: "other-task", TopicID: "other", Status: TaskDone}); err != nil {
		t.Fatal(err)
	}
	attachment, err := store.AddAttachment("task", "topic", "notes.md", strings.NewReader("# private\n"))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ name, topicID, taskID, id string }{
		{"other topic", "other", "task", attachment.ID},
		{"other task", "other", "other-task", attachment.ID},
		{"unknown id", "topic", "task", "00000000-0000-0000-0000-000000000000"},
		{"path", "topic", "task", "../" + attachment.ID},
	} {
		t.Run(test.name, func(t *testing.T) {
			if rec := serveAttachmentPreview(store, test.topicID, test.taskID, test.id, true); rec.Code != http.StatusNotFound {
				t.Fatalf("status %d", rec.Code)
			}
		})
	}
	rec := httptest.NewRecorder()
	store.ServeAttachment(rec, httptest.NewRequest(http.MethodPost, "/attachments?preview=1&topic_id=topic&task_id=task&id="+attachment.ID, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("post: %d", rec.Code)
	}
	if _, err := store.DeleteTopic("topic"); err != nil {
		t.Fatal(err)
	}
	if rec := serveAttachmentPreview(store, "topic", "task", attachment.ID, true); rec.Code != http.StatusNotFound {
		t.Fatalf("deleted topic: %d", rec.Code)
	}
}

func TestConsoleAttachmentTextCandidates(t *testing.T) {
	for name, want := range map[string]bool{
		"notes.md": true, "NOTES.TXT": true, "data.json": true, "table.csv": true, "app.log": true, "main.py": true,
		"README": true, ".gitignore": true, "dir\\file.yaml": true,
		"page.html": false, "page.htm": false, "drawing.svg": false, "feed.xml": false, "archive.zip": false,
		"photo.png": false, "report.pdf": false, "program": false, "": false,
	} {
		if got := attachmentTextCandidate(name, ""); got != want {
			t.Errorf("%q: %v", name, got)
		}
	}
	if !attachmentTextCandidate("data", "text/plain; charset=utf-8") || attachmentTextCandidate("data", "text/html") {
		t.Error("recorded type")
	}
}

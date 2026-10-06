package telegramapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSendFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "report.pdf")
	if err := os.WriteFile(path, []byte("pdf-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got struct {
		path, chatID, threadID, caption, filename, body string
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path = r.URL.Path
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("ParseMultipartForm() error = %v", err)
		}
		got.chatID = r.FormValue("chat_id")
		got.threadID = r.FormValue("message_thread_id")
		got.caption = r.FormValue("caption")
		file, header, err := r.FormFile("document")
		if err != nil {
			t.Errorf("FormFile() error = %v", err)
			return
		}
		raw, _ := io.ReadAll(file)
		got.filename, got.body = header.Filename, string(raw)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	err := SendFile(context.Background(), srv.Client(), srv.URL, "TOKEN", Upload{
		ChatID: "@reader", MessageThreadID: 7, FilePath: path, Filename: "weekly.pdf", Caption: " hi ",
		Method: "sendDocument", FormField: "document",
	})
	if err != nil {
		t.Fatalf("SendFile() error = %v", err)
	}
	if got.path != "/botTOKEN/sendDocument" || got.chatID != "@reader" || got.threadID != "7" || got.caption != "hi" || got.filename != "weekly.pdf" || got.body != "pdf-bytes" {
		t.Fatalf("request = %+v", got)
	}
}

func TestSendFileReportsAPIFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(path, []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ok":false}`)
	}))
	defer srv.Close()
	err := SendFile(context.Background(), srv.Client(), srv.URL, "T", Upload{ChatID: "1", FilePath: path, Method: "sendDocument", FormField: "document"})
	if err == nil || !strings.Contains(err.Error(), "sendDocument: ok=false") {
		t.Fatalf("error = %v", err)
	}
}

func TestCaptionFits(t *testing.T) {
	tests := []struct {
		caption string
		want    bool
	}{
		{strings.Repeat("a", MaxCaptionLength), true},
		{strings.Repeat("a", MaxCaptionLength+1), false},
		// Each emoji is two UTF-16 code units.
		{strings.Repeat("😀", MaxCaptionLength/2), true},
		{strings.Repeat("😀", MaxCaptionLength/2+1), false},
	}
	for _, tt := range tests {
		if got := CaptionFits(tt.caption); got != tt.want {
			t.Fatalf("CaptionFits(len %d) = %v, want %v", len(tt.caption), got, tt.want)
		}
	}
}

package telegram

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

func TestCollectDownloadedImageAttachmentsPreservesSourceIDs(t *testing.T) {
	files := []telegramDownloadedFile{{
		Kind:               "photo",
		Path:               "/tmp/p1.jpg",
		SourceMessageID:    "100",
		SourceAttachmentID: "file_unique_1",
	}}
	got := collectDownloadedImageAttachments(files, 3)
	if len(got) != 1 {
		t.Fatalf("collectDownloadedImageAttachments() len = %d, want 1", len(got))
	}
	if got[0].SourceMessageID != "100" || got[0].SourceAttachmentID != "file_unique_1" {
		t.Fatalf("source ids mismatch: %#v", got[0])
	}
}

func TestAppendDownloadedFilesToTaskUsesAliasPath(t *testing.T) {
	cacheDir := t.TempDir()
	filePath := filepath.Join(cacheDir, "telegram", "chat_1", "a.png")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filePath, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := appendDownloadedFilesToTask("process", []telegramDownloadedFile{{
		Kind:         "photo",
		OriginalName: "a.png",
		Path:         filePath,
	}}, pathroots.New("", cacheDir, ""))
	if !strings.Contains(got, "file_cache_dir/telegram/chat_1/a.png") {
		t.Fatalf("alias path missing: %q", got)
	}
	if strings.Contains(got, cacheDir) {
		t.Fatalf("local cache path leaked: %q", got)
	}
}

func TestTelegramFileAttachmentsIncludesVoiceAndAudio(t *testing.T) {
	msg := &telegramMessage{
		Document: &telegramDocument{FileID: "doc"},
		Voice:    &telegramDocument{FileID: "voice", MimeType: "audio/ogg"},
		Audio:    &telegramDocument{FileID: "song", FileName: "song.mp3"},
	}
	got := telegramFileAttachments(msg)
	if len(got) != 3 {
		t.Fatalf("telegramFileAttachments() len = %d, want 3", len(got))
	}
	if got[1].kind != "voice" || got[1].doc.FileName != "voice.ogg" {
		t.Fatalf("voice attachment = %#v, want kind voice named voice.ogg", got[1])
	}
	if got[2].kind != "audio" || got[2].doc.FileName != "song.mp3" {
		t.Fatalf("audio attachment = %#v", got[2])
	}
	if !messageHasDownloadableFile(&telegramMessage{Voice: &telegramDocument{FileID: "v"}}) {
		t.Fatal("a voice-only message must be downloadable")
	}
}

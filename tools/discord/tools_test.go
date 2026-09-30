package discord

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

type fakeAPI struct {
	reactions []string
	files     []string
}

func (f *fakeAPI) AddReaction(_ context.Context, channelID, messageID, emoji string) error {
	f.reactions = append(f.reactions, channelID+"/"+messageID+"/"+emoji)
	return nil
}

func (f *fakeAPI) SendFile(_ context.Context, channelID, filePath, filename, content, replyTo string) error {
	f.files = append(f.files, channelID+"|"+filepath.Base(filePath)+"|"+filename+"|"+content+"|"+replyTo)
	return nil
}

func TestNormalizeEmoji(t *testing.T) {
	for raw, want := range map[string]string{"👍": "👍", " ✅ ": "✅", "<:morph:123456789>": "morph:123456789", "<a:dance:123456789>": "dance:123456789", "morph:123456789": "morph:123456789"} {
		if got, err := NormalizeEmoji(raw); err != nil || got != want {
			t.Errorf("NormalizeEmoji(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"", "thumbsup", ":+1:", "👍 👍", "../x"} {
		if _, err := NormalizeEmoji(raw); err == nil {
			t.Errorf("NormalizeEmoji(%q) accepted", raw)
		}
	}
}

func TestReactToolDefaultsToTheTriggeringMessage(t *testing.T) {
	api := &fakeAPI{}
	tool := NewReactTool(api, "200", "300")
	if _, err := tool.Execute(context.Background(), map[string]any{"emoji": "👍"}); err != nil {
		t.Fatal(err)
	}
	if len(api.reactions) != 1 || api.reactions[0] != "200/300/👍" || tool.LastReaction() == nil {
		t.Fatalf("reactions = %v", api.reactions)
	}
}

func TestSendFileToolOnlySendsFromTheFileCache(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "report.pdf"), []byte("PDF"), 0o600); err != nil {
		t.Fatal(err)
	}
	api := &fakeAPI{}
	tool := NewSendFileTool(api, "200", "300", dir, 0)
	if _, err := tool.Execute(context.Background(), map[string]any{"path": "report.pdf", "message": "here"}); err != nil {
		t.Fatal(err)
	}
	if len(api.files) != 1 || api.files[0] != "200|report.pdf|report.pdf|here|300" {
		t.Fatalf("files = %v", api.files)
	}
	if _, err := tool.Execute(context.Background(), map[string]any{"path": "/etc/passwd"}); err == nil {
		t.Fatal("a file outside file_cache_dir was sent")
	}
}

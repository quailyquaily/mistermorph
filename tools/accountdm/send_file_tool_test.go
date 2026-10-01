package accountdm

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSendFileToolSendsOnlyFilesUnderTheCache(t *testing.T) {
	cacheDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(cacheDir, "report.pdf"), []byte("%PDF"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	_ = os.WriteFile(outside, []byte("x"), 0o600)
	var got []string
	tool := NewSendFileTool("wechat", "WeChat", func(_ context.Context, path, filename, message string) error {
		got = append(got, filepath.Base(path)+"|"+filename+"|"+message)
		return nil
	}, cacheDir, 1<<20)
	if tool.Name() != "wechat_send_file" || !strings.Contains(tool.Description(), "WeChat") {
		t.Fatalf("tool = %s: %s", tool.Name(), tool.Description())
	}
	if _, err := tool.Execute(context.Background(), map[string]any{"path": "report.pdf", "message": "done"}); err != nil {
		t.Fatal(err)
	}
	if _, err := tool.Execute(context.Background(), map[string]any{"path": outside}); err == nil {
		t.Fatal("a file outside file_cache_dir was sent")
	}
	if len(got) != 1 || got[0] != "report.pdf|report.pdf|done" {
		t.Fatalf("sent = %q", got)
	}
}

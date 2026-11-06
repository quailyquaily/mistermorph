//go:build unix

package agentsettings

import (
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// A named pipe is listed but never opened: reading one would block the request.
func TestSkillFilesDoNotOpenPipes(t *testing.T) {
	_, root, kit := newSkillFilesFixture(t)
	if err := syscall.Mkfifo(filepath.Join(kit, "pipe"), 0o644); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	listing, err := ListSkillDir([]string{root}, "kit", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(entryNames(listing.Entries), "pipe:other") {
		t.Fatalf("entries = %s, want pipe:other", entryNames(listing.Entries))
	}
	preview, err := ReadSkillFile([]string{root}, "kit", "pipe")
	if err != nil || preview.Kind != SkillPreviewUnsupported || preview.Content != "" {
		t.Fatalf("ReadSkillFile(pipe) = %+v, %v; want unsupported", preview, err)
	}
}

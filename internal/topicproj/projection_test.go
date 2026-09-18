package topicproj

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), Filename)
	updated := time.Date(2026, 9, 15, 13, 40, 0, 0, time.UTC)
	items := []taskdomain.TopicInfo{
		{ID: "a", Title: "A", CreatedAt: updated, UpdatedAt: updated},
		{ID: "b", Title: "B", CreatedAt: updated, UpdatedAt: updated},
	}
	if err := Save(path, items); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	proj, ok, err := Load(path)
	if err != nil || !ok {
		t.Fatalf("Load() ok = %v, error = %v", ok, err)
	}
	if len(proj.Items) != 2 || proj.Items[0].ID != "a" || proj.Items[1].ID != "b" {
		t.Fatalf("Load() items = %+v", proj.Items)
	}
	if proj.UpdatedAt.IsZero() {
		t.Fatal("Load() updated_at is zero")
	}
}

func TestLoadMissingFile(t *testing.T) {
	proj, ok, err := Load(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil || ok {
		t.Fatalf("Load() ok = %v, error = %v, want missing with no error", ok, err)
	}
	if proj.Items != nil {
		t.Fatalf("Load() items = %+v, want nil", proj.Items)
	}
}

func TestLoadRejectsUnknownVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), Filename)
	if err := Save(path, []taskdomain.TopicInfo{}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	bad := strings.Replace(string(raw), `"version": 1`, `"version": 999`, 1)
	if bad == string(raw) {
		t.Fatalf("test fixture changed: %s", raw)
	}
	if err := os.WriteFile(path, []byte(bad), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	_, _, err = Load(path)
	if err == nil {
		t.Fatal("Load() accepted unknown version")
	}
}

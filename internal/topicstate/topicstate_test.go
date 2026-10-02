package topicstate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDirIsStableAndSeparatesKeys(t *testing.T) {
	root := t.TempDir()
	a := Dir(root, "console:a")
	if a != Dir(root, " console:a ") {
		t.Fatalf("Dir() should ignore surrounding space")
	}
	if a == Dir(root, "console:b") {
		t.Fatalf("Dir() should differ per key")
	}
	if filepath.Dir(a) != filepath.Join(root, DirName) {
		t.Fatalf("Dir() = %q, want it under %q", a, filepath.Join(root, DirName))
	}
	if Dir("", "console:a") != "" || Dir(root, "") != "" {
		t.Fatalf("Dir() without a state dir or key should be empty")
	}
}

func TestRemoveDeletesTheFolder(t *testing.T) {
	root := t.TempDir()
	dir := Dir(root, "console:a")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "x.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	RemoveIfEmpty(root, "console:a")
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("RemoveIfEmpty() removed a folder with files")
	}
	if err := Remove(root, "console:a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("Remove() left the folder, stat err = %v", err)
	}
}

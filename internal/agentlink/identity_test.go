package agentlink

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestLoadOrCreateInstanceID(t *testing.T) {
	t.Run("creates and reuses", func(t *testing.T) {
		dir := t.TempDir()
		first, err := LoadOrCreateInstanceID(dir)
		if err != nil {
			t.Fatalf("LoadOrCreateInstanceID() error = %v", err)
		}
		if !ValidInstanceID(first) {
			t.Fatalf("instance id %q has an invalid format", first)
		}
		second, err := LoadOrCreateInstanceID(dir)
		if err != nil {
			t.Fatalf("LoadOrCreateInstanceID() second error = %v", err)
		}
		if first != second {
			t.Fatalf("instance id changed: %q then %q", first, second)
		}
	})

	t.Run("differs between state dirs with the same path shape", func(t *testing.T) {
		a, err := LoadOrCreateInstanceID(filepath.Join(t.TempDir(), "state"))
		if err != nil {
			t.Fatal(err)
		}
		b, err := LoadOrCreateInstanceID(filepath.Join(t.TempDir(), "state"))
		if err != nil {
			t.Fatal(err)
		}
		if a == b {
			t.Fatalf("two state dirs got the same id %q", a)
		}
	})

	t.Run("concurrent first start agrees", func(t *testing.T) {
		dir := t.TempDir()
		ids := make([]string, 8)
		var wg sync.WaitGroup
		for i := range ids {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				id, err := LoadOrCreateInstanceID(dir)
				if err != nil {
					t.Errorf("LoadOrCreateInstanceID() error = %v", err)
				}
				ids[i] = id
			}(i)
		}
		wg.Wait()
		for _, id := range ids {
			if id != ids[0] {
				t.Fatalf("concurrent ids differ: %v", ids)
			}
		}
	})

	t.Run("rejects a corrupt file", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, InstanceIDFile), []byte("not-an-id\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadOrCreateInstanceID(dir); err == nil {
			t.Fatal("expected an error for a corrupt instance id file")
		}
	})

	t.Run("requires a state dir", func(t *testing.T) {
		if _, err := LoadOrCreateInstanceID(" "); err == nil {
			t.Fatal("expected an error for an empty state dir")
		}
	})
}

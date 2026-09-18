package fsstore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestAcquireLockReleasedOnProcessExit(t *testing.T) {
	if path := os.Getenv("MISTERMORPH_TEST_LOCK_CHILD"); path != "" {
		if _, err := AcquireLock(context.Background(), path); err != nil {
			t.Fatal(err)
		}
		os.Exit(0) // Simulate exit without calling release.
	}
	path := filepath.Join(t.TempDir(), "session.lck")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, "-test.run=^TestAcquireLockReleasedOnProcessExit$")
	child.Env = append(os.Environ(), "MISTERMORPH_TEST_LOCK_CHILD="+path)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("child failed: %v %s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	release, err := AcquireLock(ctx, path)
	if err != nil {
		t.Fatalf("exited process kept the lock: %v", err)
	}
	release()
}

func TestAcquireLockHoldsUntilReleased(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.lck")
	release, err := AcquireLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := WithLock(ctx, path, func() error { return nil }); !errors.Is(err, ErrLockTimeout) {
		release()
		t.Fatalf("second owner acquired held lock: %v", err)
	}
	release()
	if err := WithLock(context.Background(), path, func() error { return nil }); err != nil {
		t.Fatalf("released lock remains held: %v", err)
	}
}

func TestWithLockRunsCriticalSection(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	lockPath, err := BuildLockPath(filepath.Join(root, ".fslocks"), "state.main")
	if err != nil {
		t.Fatalf("BuildLockPath() error = %v", err)
	}

	called := false
	err = WithLock(context.Background(), lockPath, func() error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("WithLock() error = %v", err)
	}
	if !called {
		t.Fatalf("WithLock() did not run critical section")
	}
}

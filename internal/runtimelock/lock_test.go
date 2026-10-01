package runtimelock

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOneHolderAtATime(t *testing.T) {
	dir := t.TempDir()
	lock, err := Acquire(dir, "whatsapp-abc", "morph whatsapp")
	if err != nil {
		t.Fatal(err)
	}
	// Another live process holds it.
	path := filepath.Join(dir, "locks", "whatsapp-abc.lock")
	raw, _ := json.Marshal(Holder{PID: os.Getppid(), Runtime: "console", StartedAt: time.Now()})
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var held *HeldError
	if _, err := Acquire(dir, "whatsapp-abc", "morph whatsapp"); !errors.As(err, &held) || held.Holder.Runtime != "console" {
		t.Fatalf("err = %v", err)
	}
	// Our own release does not remove someone else's lock.
	lock.Release()
	if _, err := os.Stat(path); err != nil {
		t.Fatal("another holder's lock was removed")
	}
}

func TestAStaleLockIsTakenOver(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "locks", "wechat-bot.lock")
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	raw, _ := json.Marshal(Holder{PID: 999999999, Runtime: "old"})
	_ = os.WriteFile(path, raw, 0o600)
	lock, err := Acquire(dir, "wechat-bot", "morph wechat")
	if err != nil {
		t.Fatal(err)
	}
	lock.Release()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the lock was not released")
	}
}

func TestTheSameProcessCannotTakeItTwice(t *testing.T) {
	dir := t.TempDir()
	lock, err := Acquire(dir, "wechat-bot", "console")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	var held *HeldError
	if _, err := Acquire(dir, "wechat-bot", "morph wechat"); !errors.As(err, &held) {
		t.Fatalf("err = %v", err)
	}
}

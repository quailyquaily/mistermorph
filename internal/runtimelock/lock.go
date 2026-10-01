// Package runtimelock keeps one process per account polling a channel: a lock file under the state
// directory names the process holding it. A lock whose process has exited can be taken over.
package runtimelock

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Holder is what a lock file records.
type Holder struct {
	PID       int       `json:"pid"`
	Runtime   string    `json:"runtime"`
	StartedAt time.Time `json:"started_at"`
}

// HeldError is a lock another live process holds.
type HeldError struct {
	Path   string
	Holder Holder
}

func (e *HeldError) Error() string {
	return fmt.Sprintf("another process (pid %d, %s, since %s) is already polling this account; stop it first (lock %s)",
		e.Holder.PID, e.Holder.Runtime, e.Holder.StartedAt.Format(time.RFC3339), e.Path)
}

// Lock is a held lock; Release removes it.
type Lock struct {
	path string
	pid  int
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// Acquire takes the lock for name (such as "wechat-<bot id>") in stateDir/locks, recording runtime
// ("morph wechat", "console") as the holder.
func Acquire(stateDir, name, runtime string) (*Lock, error) {
	name = strings.Trim(unsafeName.ReplaceAllString(strings.TrimSpace(name), "_"), "._")
	if name == "" {
		return nil, fmt.Errorf("lock name is required")
	}
	dir := filepath.Join(strings.TrimSpace(stateDir), "locks")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, name+".lock")
	pid := os.Getpid()
	payload, err := json.Marshal(Holder{PID: pid, Runtime: strings.TrimSpace(runtime), StartedAt: time.Now().UTC()})
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			_, writeErr := file.Write(payload)
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				_ = os.Remove(path)
				return nil, errors.Join(writeErr, closeErr)
			}
			return &Lock{path: path, pid: pid}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		// A live holder, this process included (two pollers in one process conflict too), keeps it.
		holder, readErr := readHolder(path)
		if readErr == nil && (holder.PID == pid || processAlive(holder.PID)) {
			return nil, &HeldError{Path: path, Holder: holder}
		}
		// The holder exited (or the file is unreadable): take the lock over.
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return nil, fmt.Errorf("could not take lock %s", path)
}

// Release removes the lock if this process still holds it.
func (l *Lock) Release() {
	if l == nil {
		return
	}
	if holder, err := readHolder(l.path); err == nil && holder.PID == l.pid {
		_ = os.Remove(l.path)
	}
}

func readHolder(path string) (Holder, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Holder{}, err
	}
	var holder Holder
	if err := json.Unmarshal(raw, &holder); err != nil {
		return Holder{}, err
	}
	return holder, nil
}

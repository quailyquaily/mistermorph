package daemonruntime

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/quailyquaily/mistermorph/internal/domainjournal"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

const (
	taskProjectionSnapshotFilename = "projection.json"
	taskProjectionSnapshotVersion  = 1
)

type taskProjectionSnapshot struct {
	Version   int                    `json:"version"`
	UpdatedAt time.Time              `json:"updated_at"`
	Cursor    domainjournal.Cursor   `json:"cursor"`
	Items     []TaskInfo             `json:"items,omitempty"`
	Topics    []TopicInfo            `json:"topics,omitempty"`
	Triggers  map[string]TaskTrigger `json:"triggers,omitempty"`
}

func loadTaskProjectionSnapshot(rootDir string) (taskProjectionSnapshot, bool, error) {
	path := taskProjectionSnapshotPath(rootDir)
	var snap taskProjectionSnapshot
	ok, err := fsstore.ReadJSON(path, &snap)
	if err != nil || !ok {
		return taskProjectionSnapshot{}, ok, err
	}
	if snap.Version != taskProjectionSnapshotVersion {
		return taskProjectionSnapshot{}, false, fmt.Errorf("task projection snapshot version = %d, want %d", snap.Version, taskProjectionSnapshotVersion)
	}
	if err := validateTaskProjectionSnapshotCursor(snap.Cursor); err != nil {
		return taskProjectionSnapshot{}, false, err
	}
	if snap.Triggers == nil {
		snap.Triggers = map[string]TaskTrigger{}
	}
	return snap, true, nil
}

func saveTaskProjectionSnapshot(rootDir string, snap taskProjectionSnapshot) error {
	snap.Version = taskProjectionSnapshotVersion
	if snap.UpdatedAt.IsZero() {
		snap.UpdatedAt = time.Now().UTC()
	} else {
		snap.UpdatedAt = snap.UpdatedAt.UTC()
	}
	if err := validateTaskProjectionSnapshotCursor(snap.Cursor); err != nil {
		return err
	}
	if snap.Triggers == nil {
		snap.Triggers = map[string]TaskTrigger{}
	}
	return fsstore.WriteJSONAtomic(taskProjectionSnapshotPath(rootDir), snap, fsstore.FileOptions{})
}

func taskProjectionSnapshotPath(rootDir string) string {
	return filepath.Join(filepath.Clean(rootDir), taskProjectionSnapshotFilename)
}

func validateTaskProjectionSnapshotCursor(cursor domainjournal.Cursor) error {
	// A cursor into JSONL segments comes from before the journal moved to SQLite. Rejecting it
	// makes the store replay the whole journal and save a snapshot with a seq cursor.
	if cursor.File != "" || cursor.Line != 0 || cursor.Byte != 0 {
		return fmt.Errorf("task projection snapshot cursor names a JSONL segment; replaying the journal")
	}
	if cursor.Seq < 0 {
		return fmt.Errorf("task projection snapshot cursor.seq must be >= 0")
	}
	return nil
}

// Package topicproj holds the lightweight topics projection file that the
// Console runtime writes after every topic mutation so local clients can list
// shared topics without a runtime API connection. The journal remains the
// source of truth; this file is a read cache.
package topicproj

import (
	"time"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

const (
	// Version is the current projection schema version.
	Version = 1

	// Filename is the conventional projection file name inside the stats dir.
	Filename = "topics_projection.json"
)

type Projection struct {
	Version   int                      `json:"version"`
	UpdatedAt time.Time                `json:"updated_at,omitempty"`
	Items     []taskdomain.TopicInfo   `json:"items"`
}

// Save writes the projection atomically. Items must be pre-ordered.
func Save(path string, items []taskdomain.TopicInfo) error {
	if items == nil {
		items = []taskdomain.TopicInfo{}
	}
	return fsstore.WriteJSONAtomic(path, Projection{
		Version:   Version,
		UpdatedAt: time.Now().UTC(),
		Items:     items,
	}, fsstore.FileOptions{})
}

// Load reads the projection. ok is false when the file does not exist or is
// empty; a schema mismatch is a hard error.
func Load(path string) (Projection, bool, error) {
	var proj Projection
	ok, err := fsstore.ReadJSON(path, &proj)
	if err != nil || !ok {
		return Projection{}, ok, err
	}
	if proj.Version != Version {
		return Projection{}, false, fsstore.ErrDecodeFailed
	}
	if proj.Items == nil {
		proj.Items = []taskdomain.TopicInfo{}
	}
	return proj, true, nil
}

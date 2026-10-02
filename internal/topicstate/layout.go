package topicstate

import (
	"context"
	"path/filepath"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

// Layout is how a person arranged the topic list's tag view: the order of the tag groups, and the
// order of the topics inside the tag groups and the pinned group. Groups are named as the console
// names them: "tag:<tag>" with the tag in lower case, and "pinned". Groups and topics missing from
// the layout keep their default order.
type Layout struct {
	TagOrder   []string            `json:"tag_order"`
	TopicOrder map[string][]string `json:"topic_order"`
}

// Limits that keep a layout file small whatever a client sends.
const (
	maxLayoutGroups      = 500
	maxLayoutTopics      = 2000
	maxLayoutKeyLength   = 160
	layoutFileName       = "layout.json"
	layoutLockName       = "topic_layout.lck"
	layoutFilePermission = 0o600
)

var layoutMu sync.Mutex

func layoutPath(stateDir string) string {
	return filepath.Join(strings.TrimSpace(stateDir), DirName, layoutFileName)
}

func layoutLockPath(stateDir string) string {
	return filepath.Join(strings.TrimSpace(stateDir), "locks", layoutLockName)
}

// LoadLayout reads the topic layout; a missing file is an empty layout.
func LoadLayout(stateDir string) (Layout, error) {
	if strings.TrimSpace(stateDir) == "" {
		return NormalizeLayout(Layout{}), nil
	}
	var layout Layout
	if _, err := fsstore.ReadJSON(layoutPath(stateDir), &layout); err != nil {
		return NormalizeLayout(Layout{}), err
	}
	return NormalizeLayout(layout), nil
}

// SaveLayout replaces the topic layout and returns what was stored.
func SaveLayout(stateDir string, layout Layout) (Layout, error) {
	layout = NormalizeLayout(layout)
	if strings.TrimSpace(stateDir) == "" {
		return layout, nil
	}
	return layout, withLayoutLock(stateDir, func() error {
		return writeLayout(stateDir, layout)
	})
}

// RemoveTopicFromLayout drops a deleted topic from every group's order.
func RemoveTopicFromLayout(stateDir string, topicID string) error {
	topicID = strings.TrimSpace(topicID)
	if strings.TrimSpace(stateDir) == "" || topicID == "" {
		return nil
	}
	return withLayoutLock(stateDir, func() error {
		var layout Layout
		found, err := fsstore.ReadJSON(layoutPath(stateDir), &layout)
		if err != nil || !found {
			return err
		}
		changed := false
		for group, ids := range layout.TopicOrder {
			kept := ids[:0]
			for _, id := range ids {
				if strings.TrimSpace(id) == topicID {
					changed = true
					continue
				}
				kept = append(kept, id)
			}
			layout.TopicOrder[group] = kept
		}
		if !changed {
			return nil
		}
		return writeLayout(stateDir, NormalizeLayout(layout))
	})
}

func withLayoutLock(stateDir string, fn func() error) error {
	layoutMu.Lock()
	defer layoutMu.Unlock()
	return fsstore.WithLock(context.Background(), layoutLockPath(stateDir), fn)
}

func writeLayout(stateDir string, layout Layout) error {
	return fsstore.WriteJSONAtomic(layoutPath(stateDir), layout, fsstore.FileOptions{DirPerm: 0o700, FilePerm: layoutFilePermission})
}

// NormalizeLayout trims names, drops empty and repeated ones and empty groups, and caps the sizes.
func NormalizeLayout(layout Layout) Layout {
	out := Layout{TagOrder: cleanKeys(layout.TagOrder, maxLayoutGroups), TopicOrder: map[string][]string{}}
	for group, ids := range layout.TopicOrder {
		group = strings.TrimSpace(group)
		if group == "" || len(group) > maxLayoutKeyLength || len(out.TopicOrder) >= maxLayoutGroups {
			continue
		}
		if cleaned := cleanKeys(ids, maxLayoutTopics); len(cleaned) > 0 {
			out.TopicOrder[group] = cleaned
		}
	}
	return out
}

func cleanKeys(keys []string, limit int) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" || len(key) > maxLayoutKeyLength || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
		if len(out) >= limit {
			break
		}
	}
	return out
}

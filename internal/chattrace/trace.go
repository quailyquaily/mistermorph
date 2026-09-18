// Package chattrace defines the retained execution records shared by Console
// and terminal chat. It contains data only; each client owns its rendering.
package chattrace

import (
	"github.com/quailyquaily/mistermorph/agent"
	"time"
)

type Snapshot struct {
	Entries []Entry `json:"entries"`
	Omitted int     `json:"omitted,omitempty"`
}
type Entry struct {
	Seq      uint64      `json:"seq"`
	At       time.Time   `json:"at"`
	Deadline time.Time   `json:"deadline,omitempty"`
	Event    agent.Event `json:"event"`
	Plan     *agent.Plan `json:"plan,omitempty"`
	File     *FileChange `json:"file,omitempty"`
}
type FileChange struct {
	Path   string `json:"path"`
	Before string `json:"before"`
	After  string `json:"after"`
}

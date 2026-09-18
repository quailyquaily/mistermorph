package chattrace

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

type Collector struct {
	mu      sync.Mutex
	taskID  string
	roots   pathroots.PathRoots
	guard   *guard.Guard
	publish func(Snapshot)
	data    Snapshot
	seq     uint64
	bytes   int
	sizes   []int
	files   map[string]FileChange
}

func NewCollector(taskID string, roots pathroots.PathRoots, g *guard.Guard, publish func(Snapshot)) *Collector {
	return &Collector{taskID: taskID, roots: roots, guard: g, publish: publish, files: map[string]FileChange{}}
}

func (s *Collector) HandleEvent(ctx context.Context, event agent.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := Entry{At: time.Now(), Event: event}
	if ctx != nil {
		entry.Deadline, _ = ctx.Deadline()
	}
	if event.ToolName == "write_file" {
		path, _ := event.Args["path"].(string)
		_, resolved, err := builtin.ResolveWritePath(s.roots, path)
		if err == nil {
			key := event.RunID + ":" + event.ActivityID
			switch event.Kind {
			case agent.EventKindToolStart:
				before, err := readConsoleTraceFile(resolved)
				if err == nil || os.IsNotExist(err) {
					s.files[key] = FileChange{Path: path, Before: before}
				}
			case agent.EventKindToolDone:
				if change, ok := s.files[key]; ok {
					delete(s.files, key)
					if after, err := readConsoleTraceFile(resolved); err == nil && event.Error == "" && after != change.Before {
						change.After = after
						entry.File = &change
					}
				}
			}
		}
	}
	if s.guard.Enabled() {
		// Completed tool events have already passed engine post-tool Guard.
		// Raw streaming deltas have not.
		if event.Kind == agent.EventKindToolOutput {
			entry.Event.Text = ""
			entry.Event.Summary = ""
			entry.Event.Error = ""
		}
	}
	s.append(entry)
}

func readConsoleTraceFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 64*1024+1))
	if len(data) > 64*1024 {
		return "", io.ErrShortBuffer
	}
	return string(data), err
}

func (s *Collector) RecordPlan(plan *agent.Plan) {
	if plan == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.append(Entry{At: time.Now(), Plan: plan, Event: agent.Event{RunID: s.taskID}})
}

func (s *Collector) append(entry Entry) {
	// Clone before redacting so tool parameters and the engine's plan remain
	// untouched. Redact text fields before JSON encoding: multiline patterns
	// must see real newlines, and structural IDs must still link child events.
	raw, err := json.Marshal(entry)
	if err != nil {
		return
	}
	var cloned Entry
	if json.Unmarshal(raw, &cloned) != nil {
		return
	}
	entry = cloned
	if s.guard.Enabled() {
		for _, value := range []*string{&entry.Event.Text, &entry.Event.Summary, &entry.Event.Error, &entry.Event.ToolName, &entry.Event.Model, &entry.Event.Profile} {
			*value, _ = s.guard.RedactString(*value)
		}
		redactConsoleTraceValue(s.guard, entry.Event.Args)
		if entry.File != nil {
			entry.File.Path, _ = s.guard.RedactString(entry.File.Path)
			entry.File.Before, _ = s.guard.RedactString(entry.File.Before)
			entry.File.After, _ = s.guard.RedactString(entry.File.After)
		}
		if entry.Plan != nil {
			for i := range entry.Plan.Steps {
				entry.Plan.Steps[i].Step, _ = s.guard.RedactString(entry.Plan.Steps[i].Step)
			}
		}
	}
	for _, value := range []*string{&entry.Event.Text, &entry.Event.Summary, &entry.Event.Error} {
		if len(*value) > 16*1024 {
			n := 16 * 1024
			for n > 0 && !utf8.RuneStart((*value)[n]) {
				n--
			}
			*value = (*value)[:n] + "\n… output truncated"
		}
	}
	s.seq++
	entry.Seq = s.seq
	raw, _ = json.Marshal(entry)
	if len(raw) > 192*1024 {
		entry.Event.Args = nil
		entry.File = nil
		entry.Plan = nil
		entry.Event.Summary = "… oversized detail omitted"
		raw, _ = json.Marshal(entry)
	}
	s.data.Entries = append(s.data.Entries, entry)
	s.sizes = append(s.sizes, len(raw))
	s.bytes += len(raw)
	for len(s.data.Entries) > 512 || s.bytes > 256*1024 {
		index := 0
		// Keep child identities and completion states available for inspection.
		for i, entry := range s.data.Entries {
			if entry.Event.Kind != agent.EventKindSubtaskStart && entry.Event.Kind != agent.EventKindSubtaskDone {
				index = i
				break
			}
		}
		s.bytes -= s.sizes[index]
		s.sizes = append(s.sizes[:index], s.sizes[index+1:]...)
		s.data.Entries = append(s.data.Entries[:index], s.data.Entries[index+1:]...)
		s.data.Omitted++
	}
	if s.publish != nil {
		s.publish(s.copyLocked())
	}
}

func redactConsoleTraceValue(g *guard.Guard, value any) any {
	switch value := value.(type) {
	case string:
		redacted, _ := g.RedactString(value)
		return redacted
	case map[string]any:
		for key, item := range value {
			value[key] = redactConsoleTraceValue(g, item)
		}
	case []any:
		for i, item := range value {
			value[i] = redactConsoleTraceValue(g, item)
		}
	}
	return value
}

func (s *Collector) copyLocked() Snapshot {
	raw, _ := json.Marshal(s.data)
	var snapshot Snapshot
	_ = json.Unmarshal(raw, &snapshot)
	return snapshot
}
func (s *Collector) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.copyLocked()
}

func (s *Collector) Restore(snapshot Snapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = snapshot
	s.data = s.copyLocked()
	s.bytes = 0
	s.sizes = nil
	for _, entry := range s.data.Entries {
		raw, _ := json.Marshal(entry)
		s.sizes = append(s.sizes, len(raw))
		s.bytes += len(raw)
		if entry.Seq > s.seq {
			s.seq = entry.Seq
		}
	}
}

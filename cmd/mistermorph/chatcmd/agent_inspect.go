package chatcmd

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
)

const (
	chatAgentMaxRecords = 32
	chatAgentMaxEntries = 128
	chatAgentMaxText    = 16 * 1024
	chatAgentMaxBytes   = 256 * 1024
)

type chatAgentEntry struct {
	At          time.Time
	Label, Text string
}

type chatAgentRecord struct {
	ID, ParentID, Task, Model string
	Status, Activity, Error   string
	Step                      int
	Started, Updated          time.Time
	Finished, Deadline        time.Time
	Entries                   []chatAgentEntry
	Omitted                   int
	bytes                     int
}

// chatAgentStore retains bounded, session-local transcripts independently of
// which thread the user is viewing. Tool goroutines never wait on the TUI.
type chatAgentStore struct {
	mu      sync.Mutex
	records map[string]*chatAgentRecord
}

func (s *chatAgentStore) HandleEvent(ctx context.Context, event agent.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	id := event.RunID
	if event.Kind == agent.EventKindSubtaskStart || event.Kind == agent.EventKindSubtaskDone {
		id = event.TaskID
	}
	if id == "" {
		return
	}
	if s.records == nil {
		s.records = make(map[string]*chatAgentRecord)
	}
	record := s.records[id]
	if event.Kind == agent.EventKindSubtaskStart {
		if record != nil {
			return
		}
		record = &chatAgentRecord{
			ID: id, ParentID: event.RunID, Task: boundedChatAgentText(event.Text), Model: event.Model,
			Status: "running", Activity: "Starting", Started: now, Updated: now,
		}
		if ctx != nil {
			record.Deadline, _ = ctx.Deadline()
		}
		s.records[id] = record
		record.appendEntry(now, "Task", record.Task)
		s.prune()
		return
	}
	// Root-agent events and events for evicted records cannot create new rows.
	if record == nil || (!record.Finished.IsZero() && event.Kind != agent.EventKindSubtaskDone) {
		return
	}
	if event.Step > record.Step {
		record.Step = event.Step
	}
	if event.Model != "" {
		record.Model = event.Model
	}
	record.Updated = now
	switch event.Kind {
	case agent.EventKindTurnStart:
		record.Activity = "Starting model"
	case agent.EventKindLLMStart:
		record.Activity = "Waiting for model"
		record.appendEntry(now, fmt.Sprintf("Model request · step %d", event.Step), "")
	case agent.EventKindLLMDone:
		record.Activity = "Processing response"
		if event.Error != "" {
			record.appendEntry(now, "Model error", event.Error)
		}
	case agent.EventKindToolStart:
		record.Activity = "Running " + event.ToolName
		record.appendEntry(now, "Tool", formatChatToolTranscript(agent.ToolCall{Name: event.ToolName, Params: event.Args}, 0))
	case agent.EventKindToolDone:
		record.Activity = "Waiting for model"
		label := "✓ " + event.ToolName
		if event.Error != "" {
			label = "× " + event.ToolName
		}
		output := event.Text
		if event.ToolName == "bash" || event.ToolName == "powershell" {
			if shell, ok := chatShellOutput(output); ok {
				output = shell
			}
		}
		if event.Error != "" && !strings.Contains(output, event.Error) {
			output += "\n" + event.Error
		}
		record.appendEntry(now, label, output)
	case agent.EventKindContextCompactionStart:
		record.Activity = "Compacting context"
		record.appendEntry(now, "Context compaction", "Started")
	case agent.EventKindContextCompactionDone, agent.EventKindContextCompactionFailed:
		record.appendEntry(now, "Context compaction", strings.TrimSpace(event.Summary+" "+event.Error))
	case agent.EventKindTurnDone:
		record.Status = "done"
		if event.Status == "failed" {
			record.Status = "failed"
		}
		record.Finished = now
		record.Activity = ""
		if event.Text != "" {
			record.appendEntry(now, "Assistant", event.Text)
		}
		if event.Error != "" {
			record.Error = boundedChatAgentText(event.Error)
			record.appendEntry(now, "Error", event.Error)
		}
	case agent.EventKindTurnCanceled:
		record.Status = "canceled"
		if event.Reason == "context_deadline_exceeded" {
			record.Status = "timed_out"
		}
		record.Finished, record.Activity, record.Error = now, "", boundedChatAgentText(event.Error)
		record.appendEntry(now, record.Status, event.Error)
	case agent.EventKindSubtaskDone:
		if record.Finished.IsZero() {
			record.Finished = now
			if event.Summary != "" {
				record.appendEntry(now, "Result", event.Summary)
			}
		}
		if record.Status != "canceled" && record.Status != "timed_out" {
			record.Status = event.Status
			if strings.Contains(event.Error, context.DeadlineExceeded.Error()) {
				record.Status = "timed_out"
			} else if strings.Contains(event.Error, context.Canceled.Error()) {
				record.Status = "canceled"
			}
		}
		record.Activity = ""
		if event.Error != "" && record.Error != event.Error {
			record.Error = boundedChatAgentText(event.Error)
			record.appendEntry(now, "Error", event.Error)
		}
	}
	s.prune()
}

// HandleRetry reports whether the notice belongs to a known child, allowing
// the caller to keep child retries in that thread instead of the main chat.
func (s *chatAgentStore) HandleRetry(ctx context.Context, event llmutil.RetryEvent) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.records[llmstats.RunIDFromContext(ctx)]
	if record == nil {
		return false
	}
	if record.Finished.IsZero() {
		now := time.Now()
		record.Activity, record.Updated = event.StatusText(), now
		record.appendEntry(now, "Retry", event.StatusText())
	}
	return true
}

func (r *chatAgentRecord) appendEntry(at time.Time, label, text string) {
	entry := chatAgentEntry{At: at, Label: boundedChatAgentText(label), Text: boundedChatAgentText(text)}
	r.Entries = append(r.Entries, entry)
	r.bytes += len(entry.Label) + len(entry.Text)
	for len(r.Entries) > chatAgentMaxEntries || r.bytes > chatAgentMaxBytes {
		r.bytes -= len(r.Entries[0].Label) + len(r.Entries[0].Text)
		r.Entries[0] = chatAgentEntry{}
		r.Entries = r.Entries[1:]
		r.Omitted++
	}
}

func boundedChatAgentText(text string) string {
	if len(text) <= chatAgentMaxText {
		return text
	}
	n := chatAgentMaxText
	for n > 0 && !utf8.RuneStart(text[n]) {
		n--
	}
	return text[:n] + "\n… output truncated"
}

// prune never evicts a running child. Once a child finishes, the oldest
// completed records are removed until the session is back under the limit.
func (s *chatAgentStore) prune() {
	for len(s.records) > chatAgentMaxRecords {
		var oldest *chatAgentRecord
		for _, record := range s.records {
			if !record.Finished.IsZero() && (oldest == nil || record.Finished.Before(oldest.Finished)) {
				oldest = record
			}
		}
		if oldest == nil {
			return
		}
		delete(s.records, oldest.ID)
	}
}

func (s *chatAgentStore) snapshot() []chatAgentRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := make([]chatAgentRecord, 0, len(s.records))
	for _, record := range s.records {
		row := *record
		row.Entries = append([]chatAgentEntry(nil), record.Entries...)
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Finished.IsZero() != rows[j].Finished.IsZero() {
			return rows[i].Finished.IsZero()
		}
		return rows[i].Started.Before(rows[j].Started)
	})
	return rows
}

func findChatAgent(rows []chatAgentRecord, prefix string) (chatAgentRecord, error) {
	for _, row := range rows {
		if row.ID == prefix {
			return row, nil
		}
	}
	var found *chatAgentRecord
	for i := range rows {
		row := &rows[i]
		if strings.HasPrefix(row.ID, prefix) || strings.HasPrefix(strings.TrimPrefix(row.ID, "sub_"), prefix) {
			if found != nil {
				return chatAgentRecord{}, fmt.Errorf("Agent ID %q is ambiguous. Use a longer prefix.", prefix)
			}
			found = row
		}
	}
	if found == nil {
		return chatAgentRecord{}, fmt.Errorf("No retained subagent matches %q in this session.", prefix)
	}
	return *found, nil
}

func isChatAgentCommand(command string) bool {
	switch chatcommands.NormalizeCommand(command) {
	case "/agents", "/agent", "/subagents":
		return true
	}
	return false
}

package chatcmd

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/chattrace"
	"github.com/quailyquaily/mistermorph/internal/clifmt"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

type remoteHistoryRow struct {
	id, task, role, text, status string
	structured                   bool
}

func remoteHistory(tasks map[string]taskdomain.TaskInfo) []remoteHistoryRow {
	sorted := make([]taskdomain.TaskInfo, 0, len(tasks))
	for _, t := range tasks {
		sorted = append(sorted, t)
	}
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].CreatedAt.Equal(sorted[j].CreatedAt) {
			return sorted[i].ID < sorted[j].ID
		}
		return sorted[i].CreatedAt.Before(sorted[j].CreatedAt)
	})
	var rows []remoteHistoryRow
	for _, t := range sorted {
		rows = append(rows, remoteHistoryRow{id: t.ID + ":user", task: t.ID, role: "user", text: t.Task})
		role := "assistant"
		if t.SteerTargetTaskID != "" {
			role = "system"
		}
		status := ""
		switch t.Status {
		case taskdomain.TaskPending:
			status = "Waiting for approval"
			if t.ApprovalRequestID != "" {
				status += " " + t.ApprovalRequestID
			}
			status += " · /approve or /deny"
		case taskdomain.TaskFailed:
			status = "Failed"
		case taskdomain.TaskCanceled:
			status = "Canceled"
		}
		if t.Error != "" {
			if status != "" {
				status += ": "
			}
			status += t.Error
		}
		raw, _ := json.Marshal(t.Result)
		var result struct {
			Final *agent.Final `json:"final"`
		}
		_ = json.Unmarshal(raw, &result)
		text := formatRawChatOutput(result.Final)
		structured := false
		if result.Final != nil {
			_, isString := result.Final.Output.(string)
			structured = !isString
		}
		if t.SteerTargetTaskID != "" && t.Status == taskdomain.TaskDone && text == "" {
			status = "Additional instruction accepted"
		}
		rows = append(rows, remoteHistoryRow{id: t.ID + ":" + role, task: t.ID, role: role, text: text, status: status, structured: structured})
	}
	// Same projection as Console: each target answer follows its latest loaded
	// steer user. Missing targets are retained as associations, not invented.
	for _, t := range sorted {
		if t.SteerTargetTaskID == "" {
			continue
		}
		idx := -1
		for i, r := range rows {
			if r.task == t.SteerTargetTaskID && r.role == "assistant" {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue
		}
		answer := rows[idx]
		rows = append(rows[:idx], rows[idx+1:]...)
		for i, r := range rows {
			if r.id == t.ID+":user" {
				rows = append(rows, remoteHistoryRow{})
				copy(rows[i+2:], rows[i+1:])
				rows[i+1] = answer
				break
			}
		}
	}
	return rows
}
func (m *chatModel) printHistory(full bool) tea.Cmd {
	var b strings.Builder
	if full {
		title := remoteLine(m.topic.Title)
		if title == "" {
			title = "Conversation"
		}
		fmt.Fprintln(&b, chatSecondaryStyle.Render("── "+title+" ──")+"\n")
	}
	for _, r := range remoteHistory(m.tasks) {
		if r.role == "assistant" {
			b.WriteString(m.renderSharedTrace(r.task, remoteHistoryTrace(m.tasks[r.task]), full))
		}
		if r.text != "" && (full || m.printed[r.id] != r.text) {
			text := remoteDisplay(r.text)
			switch r.role {
			case "user":
				text = formatSubmittedInput(text, m.width-1)
			case "assistant":
				if !r.structured {
					name, _ := chatcommands.ParseCommand(m.tasks[r.task].Task)
					switch chatcommands.NormalizeCommand(name) {
					case "/models", "/skills", "/ctx", "/reset", "/init", "/update":
						text = formatChatCommandOutput(name, text, m.commandRegistry)
					default:
						text = clifmt.RenderMarkdown(text)
					}
				}
			case "system":
				text = chatSecondaryStyle.Render(text)
			}
			b.WriteString(strings.TrimRight(text, "\n") + "\n\n")
		}
		m.printed[r.id] = r.text
		if r.status != "" && (full || m.printed[r.id+":status"] != r.status) {
			fmt.Fprintln(&b, chatSecondaryStyle.Render(remoteDisplay(r.status))+"\n")
		}
		m.printed[r.id+":status"] = r.status
	}
	if b.Len() == 0 {
		return nil
	}
	return m.enqueueTranscript(strings.TrimSuffix(b.String(), "\n"))
}

// Older tasks stored a final plan and a bounded activity list. Restore the
// available records without inventing tool output or timestamps that were lost.
func remoteHistoryTrace(task taskdomain.TaskInfo) chattrace.Snapshot {
	type activity struct {
		ID, Kind, Name, Status, Output, Summary, Error string
		Args                                           map[string]any
	}
	var result struct {
		Trace    *chattrace.Snapshot `json:"trace"`
		Plan     *agent.Plan         `json:"plan"`
		Activity struct {
			Current *activity  `json:"current"`
			History []activity `json:"history"`
		} `json:"activity"`
	}
	raw, _ := json.Marshal(task.Result)
	_ = json.Unmarshal(raw, &result)
	if result.Trace != nil {
		return *result.Trace
	}
	var trace chattrace.Snapshot
	if remoteStreamActive(task) {
		return trace
	}
	if result.Plan != nil {
		trace.Entries = append(trace.Entries, chattrace.Entry{Seq: 1, Plan: result.Plan, Event: agent.Event{RunID: task.ID}})
	}
	items := result.Activity.History
	if result.Activity.Current != nil {
		items = append(items, *result.Activity.Current)
	}
	seen := map[string]bool{}
	for _, item := range items {
		if item.ID != "" && seen[item.ID] {
			continue
		}
		seen[item.ID] = true
		event := agent.Event{RunID: task.ID, ToolName: item.Name, Args: item.Args, Text: item.Output, Error: item.Error}
		switch item.Kind {
		case "tool":
			if item.Status != "done" && item.Status != "failed" && item.Status != "canceled" {
				continue
			}
			event.Kind = agent.EventKindToolDone
		case "retry":
			event.Kind, event.Text = agent.EventKindLLMRetry, item.Summary
		default:
			continue
		}
		trace.Entries = append(trace.Entries, chattrace.Entry{Seq: uint64(len(trace.Entries) + 1), Event: event})
	}
	return trace
}

// Runtime content is data, not terminal control sequences (including OSC).
func remoteDisplay(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, ansi.Strip(text))
}

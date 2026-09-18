package chatcmd

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

type topicView struct {
	traceSeq                  map[string]uint64
	traceActivity             map[string]string
	scopeReady                bool
	topic                     taskdomain.TopicInfo
	tasks                     map[string]taskdomain.TaskInfo
	printed                   map[string]string
	cursor                    string
	listing, loading          bool
	scope, filter, listCursor string
	topics                    []taskdomain.TopicInfo
	selected                  int
	confirm                   string
}

// History and execution records belong to the selected topic, independent of
// whether its tasks came from local storage or a runtime endpoint.
func (m *chatModel) resetTopicHistory() {
	m.tasks = map[string]taskdomain.TaskInfo{}
	m.printed = map[string]string{}
	m.traceSeq, m.traceActivity = nil, nil
	m.agents.mu.Lock()
	m.agents.records = nil
	m.agents.mu.Unlock()
}

// Navigation changes only the list view. Topic actions retain their executor's
// request, cancellation, and draft handling.
func (m *chatModel) updateTopicNavigation(msg tea.Msg) bool {
	if !m.listing {
		return false
	}
	switch msg := msg.(type) {
	case tea.PasteMsg:
		m.filter += remoteDisplay(msg.Content)
		m.selected = 0
	case tea.KeyPressMsg:
		if m.confirm != "" {
			return false
		}
		switch msg.String() {
		case "up":
			m.selected = max(0, m.selected-1)
		case "down":
			m.selected = min(max(0, len(m.listRows())-1), m.selected+1)
		case "backspace":
			text := []rune(m.filter)
			if len(text) > 0 {
				m.filter = string(text[:len(text)-1])
			}
			m.selected = 0
		default:
			return false
		}
	default:
		return false
	}
	return true
}

func (m *chatModel) matches() []taskdomain.TopicInfo {
	var out []taskdomain.TopicInfo
	for _, t := range m.topics {
		if strings.Contains(strings.ToLower(t.Title+" "+t.ID), strings.ToLower(m.filter)) {
			out = append(out, t)
		}
	}
	return out
}

// Topic rows and explicit local actions share the same keyboard selection.
// An empty ID identifies an action, never a fallback topic.
type topicListRow struct{ id, action, label string }

func (m *chatModel) listRows() []topicListRow {
	var rows []topicListRow
	for _, t := range m.matches() {
		id := []rune(t.ID)
		if len(id) > 12 {
			id = id[:12]
		}
		rows = append(rows, topicListRow{id: t.ID, label: fmt.Sprintf("%s [%s] %s", t.Title, string(id), t.UpdatedAt.Format("2006-01-02 15:04"))})
	}
	if m.scopeReady {
		rows = append(rows, topicListRow{action: "new", label: "New topic"})
	}
	if m.scopeReady && m.listCursor != "" {
		rows = append(rows, topicListRow{action: "more", label: "Load more"})
	}
	return rows
}

func (m *chatModel) viewTopics() tea.View {
	dir := m.scope
	if !m.scopeReady {
		dir = "resolving workspace…"
	} else if dir == "" {
		dir = "unbound workspace"
	}
	lines := []string{chatAccentStyle.Render("Topics — " + remoteLine(dir)), chatMutedStyle.Render(remoteLine(m.notice)), "Filter (loaded titles/IDs only): " + remoteLine(m.filter)}
	notice := ""
	if m.loading {
		notice = "Loading…"
	} else if len(m.matches()) == 0 {
		notice = "No matching topics"
	}
	if notice != "" {
		lines = append(lines, notice)
	}
	// Reserve a row for selection even on very short terminals.
	if len(lines) > max(0, m.height-2) {
		lines = lines[:max(0, m.height-2)]
	}
	rows := m.listRows()
	count := max(1, m.height-len(lines)-1)
	selected := min(max(0, m.selected), max(0, len(rows)-1))
	start := max(0, selected-count+1)
	for i := start; i < len(rows) && i < start+count; i++ {
		mark := "  "
		if i == selected {
			mark = "> "
		}
		lines = append(lines, mark+remoteLine(rows[i].label))
	}
	lines = append(lines, "↑/↓ Enter · Esc back · ^S status · ^N new · ^L more · ^R refresh")
	return m.fitView(lines)
}

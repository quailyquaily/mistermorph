package chatcmd

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
)

func (m *chatModel) applyLocalHistory(r localHistoryMsg) {
	if !r.more {
		m.resetTopicHistory()
	}
	m.topic, m.cursor, m.status = r.topic, r.cursor, r.status
	m.listing, m.loading = false, false
	m.notice = ""
	for _, task := range r.tasks {
		m.tasks[task.ID] = task
	}
}

func (m *chatModel) updateLocalTopics(msg tea.Msg) (tea.Cmd, bool) {
	if m.updateTopicNavigation(msg) {
		return nil, true
	}
	switch r := msg.(type) {
	case localHistoryMsg:
		m.applyLocalHistory(r)
		if r.topic.ID != "" {
			return m.printHistory(true), true
		}
		return nil, true
	case localTopicsMsg:
		if !r.more {
			m.topics = nil
			m.selected = 0
			m.filter = ""
		}
		seen := map[string]bool{}
		for _, t := range m.topics {
			seen[t.ID] = true
		}
		for _, t := range r.items {
			if !seen[t.ID] {
				m.topics = append(m.topics, t)
			}
		}
		m.scope, m.listCursor = r.scope, r.cursor
		m.listing, m.scopeReady, m.loading = true, true, false
		m.notice = ""
		return nil, true
	case localDeleteConfirmMsg:
		m.confirm = r.id
		m.notice = "Delete this topic? y / n"
		return nil, true
	case agentResultMsg:
		m.loading = false
		if r.err != nil && m.listing {
			m.notice = r.err.Error()
		}
	case tea.KeyPressMsg:
		key := r.String()
		if m.confirm != "" {
			id := m.confirm
			m.confirm, m.notice = "", ""
			if key == "y" {
				return m.submitLocalTopicCommand("/topic delete confirm " + id), true
			}
			return nil, true
		}
		if !m.listing {
			return nil, false
		}
		rows := m.listRows()
		switch key {
		case "esc":
			m.listing = false
			m.notice = ""
		case "ctrl+c":
			if m.filter != "" {
				m.filter = ""
				m.selected = 0
			} else {
				return tea.Quit, true
			}
		case "enter":
			if !m.loading && m.selected >= 0 && m.selected < len(rows) {
				row := rows[m.selected]
				switch row.action {
				case "new":
					return m.submitLocalTopicCommand("/topic new"), true
				case "more":
					return m.submitLocalTopicCommand("/topics " + m.listCursor), true
				default:
					return m.submitLocalTopicCommand("/topic switch " + row.id), true
				}
			}
		case "ctrl+n":
			return m.submitLocalTopicCommand("/topic new"), true
		case "ctrl+l":
			if m.listCursor != "" {
				return m.submitLocalTopicCommand("/topics " + m.listCursor), true
			}
		case "ctrl+r":
			return m.submitLocalTopicCommand("/topics"), true
		case "ctrl+s":
			return m.enqueueTranscript(remoteDisplay(fmt.Sprintf("Workspace: %s", m.scope))), true
		default:
			m.filter += r.Text
			m.selected = 0
		}
		return nil, true
	}
	return nil, false
}

// Selector actions use the same serialized processor as typed commands.
func (m *chatModel) submitLocalTopicCommand(input string) tea.Cmd {
	if m.loading {
		return nil
	}
	m.loading = true
	select {
	case m.submitted <- strings.TrimSpace(input):
	default:
		m.loading = false
		m.notice = "Wait for the current command to finish."
	}
	return nil
}

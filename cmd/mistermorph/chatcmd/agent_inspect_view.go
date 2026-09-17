package chatcmd

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/quailyquaily/mistermorph/internal/clifmt"
)

type agentInspectMsg struct{ prefix string }
type agentInspectTickMsg struct{}
type agentInspectClosedMsg struct{ generation uint64 }

type chatAgentBrowser struct {
	selected string
	detail   bool
	scroll   int
	follow   bool
	err      string
}

func agentInspectTick() tea.Cmd {
	return tea.Tick(250*time.Millisecond, func(time.Time) tea.Msg { return agentInspectTickMsg{} })
}

func (m *chatModel) openAgentBrowser(prefix string) tea.Cmd {
	// Finish an in-flight Println sequence before switching screen buffers.
	// Further main-thread output waits in transcriptQueue until we return.
	if m.transcriptPrinting {
		m.pendingAgentInspect = &agentInspectMsg{prefix: prefix}
		return nil
	}
	browser := &chatAgentBrowser{follow: true}
	rows := m.agents.snapshot()
	if prefix != "" {
		row, err := findChatAgent(rows, prefix)
		if err != nil {
			browser.err = err.Error()
		} else {
			browser.selected, browser.detail = row.ID, true
		}
	} else if len(rows) > 0 {
		browser.selected = rows[0].ID
	}
	alreadyOpen := m.agentBrowser != nil
	m.agentBrowser = browser
	if alreadyOpen {
		return nil
	}
	return agentInspectTick()
}

func (m *chatModel) updateAgentBrowser(key string) tea.Cmd {
	browser := m.agentBrowser
	if key == "ctrl+g" || key == "ctrl+c" || key == "esc" && !browser.detail {
		return m.closeAgentBrowser()
	}
	if key == "esc" || key == "left" {
		browser.detail, browser.scroll = false, 0
		return nil
	}
	rows := m.agents.snapshot()
	if browser.detail {
		header, body := m.agentDetailLines(rows)
		height := max(1, m.height-len(header)-1)
		bottom := max(0, len(body)-height)
		if browser.follow {
			browser.scroll = bottom
		}
		switch key {
		case "up", "k":
			browser.scroll--
			browser.follow = false
		case "down", "j":
			browser.scroll++
		case "pgup":
			browser.scroll -= height
			browser.follow = false
		case "pgdown":
			browser.scroll += height
		case "home":
			browser.scroll, browser.follow = 0, false
		case "end":
			browser.scroll, browser.follow = bottom, true
		}
		browser.scroll = min(max(0, browser.scroll), bottom)
		if (key == "down" || key == "j" || key == "pgdown") && browser.scroll == bottom {
			browser.follow = true
		}
		return nil
	}
	if len(rows) == 0 {
		return nil
	}
	index := 0
	for i := range rows {
		if rows[i].ID == browser.selected {
			index = i
			break
		}
	}
	switch key {
	case "up", "k":
		index = max(0, index-1)
	case "down", "j":
		index = min(len(rows)-1, index+1)
	case "home":
		index = 0
	case "end":
		index = len(rows) - 1
	case "enter", "right":
		browser.detail, browser.follow, browser.scroll, browser.err = true, true, 0, ""
	}
	browser.selected = rows[index].ID
	return nil
}

func (m *chatModel) closeAgentBrowser() tea.Cmd {
	if m.agentBrowser == nil {
		return m.startTranscriptPrint()
	}
	m.agentBrowser = nil
	m.transcriptResuming = true
	m.transcriptResumeGeneration++
	generation := m.transcriptResumeGeneration
	// Bubble Tea flushes screen changes on its render timer. Let it render
	// the normal screen before Println writes queued output into scrollback.
	return tea.Tick(activityRefresh, func(time.Time) tea.Msg {
		return agentInspectClosedMsg{generation: generation}
	})
}

func (m *chatModel) viewAgentBrowser() tea.View {
	browser := m.agentBrowser
	rows := m.agents.snapshot()
	width, height := max(1, m.width-1), max(1, m.height)
	header := []string{chatAccentStyle.Render("Agents · current session · read-only"), ""}
	footer := "↑↓ select · Enter inspect · Esc/Ctrl+G main"
	var body []string
	scroll := 0
	if browser.detail {
		header, body = m.agentDetailLines(rows)
		footer = "↑↓ scroll · PgUp/PgDn · End follow · Esc agents · Ctrl+G main"
		scroll = browser.scroll
	} else {
		if browser.err != "" {
			header[1] = chatErrorStyle.Render(escapeTerminalControls(browser.err))
		}
		selectedIndex := 0
		for i, row := range rows {
			marker := "  "
			if row.ID == browser.selected || browser.selected == "" && i == 0 {
				marker, selectedIndex = "❯ ", i
			}
			line := fmt.Sprintf("%s%s · %s · %s · %s", marker, shortChatAgentID(row.ID), chatAgentStatus(row, time.Now()), chatAgentElapsed(row, time.Now()), normalizeActivityText(escapeTerminalControls(row.Task)))
			line = fitChatLine(line, width)
			if marker != "  " {
				line = chatAccentStyle.Render(line)
			}
			body = append(body, line)
		}
		if len(rows) == 0 {
			body = []string{"No subagents have started in this session."}
		}
		scroll = max(0, selectedIndex-max(1, height-len(header)-1)+1)
	}
	// Keep the footer visible even in very small terminals.
	if len(header) > max(0, height-2) {
		header = header[:max(0, height-2)]
	}
	bodyHeight := max(0, height-len(header)-1)
	bottom := max(0, len(body)-bodyHeight)
	if browser.detail && browser.follow {
		scroll = bottom
	}
	scroll = min(max(0, scroll), bottom)
	lines := append([]string(nil), header...)
	lines = append(lines, body[scroll:min(len(body), scroll+bodyHeight)]...)
	for len(lines) < height-1 {
		lines = append(lines, "")
	}
	lines = append(lines, chatMutedStyle.Render(footer))
	for i := range lines {
		lines[i] = fitChatLine(lines[i], width)
	}
	view := tea.NewView(strings.Join(lines, "\n"))
	view.AltScreen = true
	return view
}

func (m *chatModel) agentDetailLines(rows []chatAgentRecord) ([]string, []string) {
	row, err := findChatAgent(rows, m.agentBrowser.selected)
	if err != nil {
		return []string{chatAccentStyle.Render("Agent")}, []string{escapeTerminalControls(err.Error())}
	}
	now := time.Now()
	model := row.Model
	if model == "" {
		model = "—"
	}
	deadline := "No deadline"
	if !row.Deadline.IsZero() {
		deadline = "Deadline " + row.Deadline.Local().Format("15:04:05") + " · inherited"
		if row.Finished.IsZero() {
			deadline += " · remaining " + formatActivityElapsed(max(0, row.Deadline.Sub(now)))
		}
	}
	header := []string{
		chatAccentStyle.Render("Agent " + shortChatAgentID(row.ID) + " · " + chatAgentStatus(row, now) + " · read-only"),
		fmt.Sprintf("Model %s · step %d · elapsed %s", escapeTerminalControls(model), row.Step, chatAgentElapsed(row, now)),
		deadline,
	}
	if row.Finished.IsZero() && row.Activity != "" {
		header = append(header, escapeTerminalControls(row.Activity)+" · "+formatActivityElapsed(now.Sub(row.Updated)))
	}
	header = append(header, "")
	body := make([]string, 0, len(row.Entries)*3)
	if row.Omitted > 0 {
		body = append(body, chatSecondaryStyle.Render("Task"))
		body = append(body, strings.Split(ansi.Hardwrap(escapeTerminalControls(row.Task), max(1, m.width-1), false), "\n")...)
		body = append(body, "", fmt.Sprintf("… %d earlier entries omitted", row.Omitted), "")
	}
	for _, entry := range row.Entries {
		body = append(body, chatSecondaryStyle.Render(entry.At.Local().Format("15:04:05")+"  "+escapeTerminalControls(entry.Label)))
		if entry.Text != "" {
			text := escapeTerminalControls(entry.Text)
			if entry.Label == "Assistant" {
				text = strings.TrimSpace(clifmt.RenderMarkdown(text))
			}
			body = append(body, strings.Split(ansi.Hardwrap(text, max(1, m.width-1), false), "\n")...)
		}
		body = append(body, "")
	}
	return header, body
}

func shortChatAgentID(id string) string {
	id = strings.TrimPrefix(id, "sub_")
	if len(id) > 8 {
		id = id[:8]
	}
	return id
}

func chatAgentStatus(row chatAgentRecord, now time.Time) string {
	if row.Finished.IsZero() && !row.Deadline.IsZero() && !now.Before(row.Deadline) {
		return "Timed out · waiting for exit"
	}
	switch row.Status {
	case "running":
		return "Running"
	case "done":
		return "Done"
	case "failed":
		return "Failed"
	case "canceled":
		return "Canceled"
	case "timed_out":
		return "Timed out"
	}
	return row.Status
}

func chatAgentElapsed(row chatAgentRecord, now time.Time) string {
	if !row.Finished.IsZero() {
		now = row.Finished
	}
	return formatActivityElapsed(max(0, now.Sub(row.Started)))
}

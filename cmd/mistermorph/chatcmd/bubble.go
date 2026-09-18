package chatcmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	lipglosscompat "charm.land/lipgloss/v2/compat"
	"github.com/charmbracelet/x/ansi"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/caprefs"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/skillsutil"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

// Messages sent from the agent goroutine back into the TUI.
type (
	thinkingMsg struct {
		on      bool
		message string
		tool    bool
	}
	agentResultMsg struct {
		output       string
		err          error
		keepThinking bool
	}
	sessionStatusMsg      struct{ status chatSessionStatus }
	approvalMsg           struct{ record guard.ApprovalRecord }
	approvalClearedMsg    struct{}
	activityTickMsg       time.Time
	quitConfirmExpiredMsg struct{}
	transcriptPrintedMsg  struct{}
	quitMsg               struct{}
	tuiOutputMsg          struct{ output string }
)

type chatSessionStatus struct {
	model        string
	topic        string
	workspace    string
	contextRatio float64
	contextKnown bool
}

type chatPickerItem struct {
	value       string
	description string
}

type chatPicker struct {
	items         []chatPickerItem
	replaceStart  int
	replaceEnd    int
	submitOnEnter bool
}

// chatModel owns only the fixed bottom surface. Conversation history is
// printed with tea.Println so it remains in the terminal's native scrollback.
type chatModel struct {
	topicView
	*sharedChat
	textarea      textarea.Model
	sess          *chatSession
	skillItems    []skillsutil.SkillStatusItem
	skillsLoading bool
	skillsError   string
	notice        string

	historyPath  string
	inputHistory []string
	historyIdx   int
	submitted    chan string

	thinking        bool
	thinkingMessage string
	thinkingTool    bool
	runStartedAt    time.Time
	activityNow     time.Time
	status          chatSessionStatus

	width  int
	height int

	quitConfirmation  bool
	approval          *guard.ApprovalRecord
	approvalParams    map[string]any
	approvalResolving bool
	approvalScroll    int

	commandRegistry *chatcommands.Registry
	pickerIndex     int
	pickerClosed    bool

	transcriptQueue            []string
	transcriptPrinting         bool
	transcriptResuming         bool
	transcriptResumeGeneration uint64
	quitAfterTranscript        bool
	agents                     chatAgentStore
	agentBrowser               *chatAgentBrowser
	pendingAgentInspect        *agentInspectMsg

	// pastedTexts stores the original text behind each paste placeholder,
	// keyed by the exact placeholder string.
	pastedTexts map[string]string
}

const (
	maxInputHeight      = 5
	shortInputHeight    = 3
	shortTerminalHeight = 12
	quitConfirmWindow   = 2 * time.Second
	activityRefresh     = 80 * time.Millisecond
	inputMarkerWidth    = 2
	maxPickerItems      = 6
	shortPickerItems    = 3
)

// pastePlaceholderLineThreshold is the minimum line count for a bracketed
// paste to be folded into a compact placeholder.
const pastePlaceholderLineThreshold = 2

var (
	chatAccentStyle = lipgloss.NewStyle().
			Foreground(lipglosscompat.AdaptiveColor{Light: lipgloss.Color("25"), Dark: lipgloss.Color("75")}).
			Bold(true)
	chatSecondaryStyle = lipgloss.NewStyle().
				Foreground(lipglosscompat.AdaptiveColor{Light: lipgloss.Color("239"), Dark: lipgloss.Color("250")})
	chatMutedStyle = lipgloss.NewStyle().
			Foreground(lipglosscompat.AdaptiveColor{Light: lipgloss.Color("242"), Dark: lipgloss.Color("245")})
	chatInputFrameStyle = lipgloss.NewStyle().
				Border(lipgloss.NormalBorder(), true, false, true, false).
				BorderForeground(lipglosscompat.AdaptiveColor{Light: lipgloss.Color("242"), Dark: lipgloss.Color("245")})
	chatWarningStyle = lipgloss.NewStyle().
				Foreground(lipglosscompat.AdaptiveColor{Light: lipgloss.Color("130"), Dark: lipgloss.Color("214")}).
				Bold(true)
	chatSuccessStyle = lipgloss.NewStyle().
				Foreground(lipglosscompat.AdaptiveColor{Light: lipgloss.Color("28"), Dark: lipgloss.Color("77")})
	chatErrorStyle = lipgloss.NewStyle().
			Foreground(lipglosscompat.AdaptiveColor{Light: lipgloss.Color("160"), Dark: lipgloss.Color("203")})
	chatSpinnerFrames = [...]string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
)

func newChatTextarea() textarea.Model {
	ta := textarea.New()
	ta.ShowLineNumbers = false
	ta.Placeholder = "Ask a question or describe a task"
	ta.Prompt = ""
	ta.SetPromptFunc(inputMarkerWidth, func(info textarea.PromptInfo) string {
		if info.LineNumber == 0 {
			return "❯ "
		}
		return "  "
	})
	styles := ta.Styles()
	styles.Focused.Prompt = chatAccentStyle
	styles.Blurred.Prompt = chatAccentStyle
	styles.Focused.Placeholder = chatMutedStyle
	styles.Blurred.Placeholder = chatMutedStyle
	styles.Focused.CursorLine = lipgloss.NewStyle()
	styles.Blurred.CursorLine = lipgloss.NewStyle()
	ta.SetStyles(styles)
	ta.Focus()
	ta.DynamicHeight = true
	ta.MinHeight = 1
	ta.MaxHeight = maxInputHeight
	// Keep MaxHeight as a viewport cap rather than an input-length limit.
	ta.MaxContentHeight = 10_000
	ta.SetWidth(79)

	// Enter submits. Modified Enter and Ctrl+J remain composer newlines.
	ta.KeyMap.InsertNewline = key.NewBinding(key.WithKeys("shift+enter", "alt+enter", "ctrl+j"))
	return ta
}

func newChatModel(sess *chatSession) *chatModel {
	m := &chatModel{
		topicView:   topicView{tasks: map[string]taskdomain.TaskInfo{}, printed: map[string]string{}},
		textarea:    newChatTextarea(),
		sess:        sess,
		submitted:   make(chan string, 1),
		status:      chatSessionStatusFromSession(sess),
		width:       80,
		height:      24,
		pastedTexts: make(map[string]string),
	}
	if sess != nil {
		m.skillItems = sess.skillItems
	}
	return m
}

func (m *chatModel) Init() tea.Cmd {
	if m.sharedChat != nil {
		return m.initShared()
	}
	if m.topic.ID != "" {
		return tea.Batch(textarea.Blink, m.printHistory(true))
	}
	return textarea.Blink
}

func (m *chatModel) Update(msg tea.Msg) (model tea.Model, command tea.Cmd) {
	if m.sharedChat != nil {
		defer func() {
			m.save()
			if tick := m.syncSharedActivity(); tick != nil {
				command = tea.Batch(command, tick)
			}
		}()
		if cmd, handled := m.updateShared(msg); handled {
			return m, cmd
		}
	}
	if m.sharedChat == nil {
		if cmd, handled := m.updateLocalTopics(msg); handled {
			return m, cmd
		}
	}
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.textarea.MaxHeight = maxInputHeight
		if m.height > 0 && m.height < shortTerminalHeight {
			m.textarea.MaxHeight = shortInputHeight
		}
		if m.height > 0 {
			m.textarea.MaxHeight = min(m.textarea.MaxHeight, max(1, m.height-3))
		}
		m.textarea.SetWidth(m.contentWidth())
		m.clampApprovalScroll()
		return m, nil

	case tea.PasteMsg:
		if m.approval != nil || m.agentBrowser != nil {
			return m, nil
		}
		if lines := countPasteLines(msg.Content); lines >= pastePlaceholderLineThreshold {
			placeholder := fmt.Sprintf("[Pasted text #%d +%d lines]", len(m.pastedTexts)+1, lines)
			m.pastedTexts[placeholder] = msg.Content
			m.textarea.InsertString(placeholder)
			return m, nil
		}

	case tea.KeyPressMsg:
		keyName := msg.String()
		if m.agentBrowser != nil {
			return m, m.updateAgentBrowser(keyName)
		}
		if keyName == "ctrl+g" {
			return m, m.openAgentBrowser("")
		}
		if m.approval != nil {
			decision := ""
			switch keyName {
			case "up":
				m.approvalScroll = max(0, m.approvalScroll-1)
			case "down":
				m.approvalScroll++
				m.clampApprovalScroll()
			case "ctrl+c", "esc":
				decision = "n"
			default:
				if strings.EqualFold(msg.Key().Text, "y") {
					decision = "y"
				} else if strings.EqualFold(msg.Key().Text, "n") {
					decision = "n"
				}
			}
			if decision != "" && !m.approvalResolving {
				if m.sharedChat != nil {
					return m, m.decideSharedApproval(decision == "y")
				}
				m.approvalResolving = true
				select {
				case m.submitted <- decision:
				default:
					m.approvalResolving = false
				}
			}
			return m, nil
		}

		picker := m.picker()
		if len(picker.items) > 0 {
			switch keyName {
			case "esc":
				m.pickerClosed = true
				return m, nil
			case "up":
				m.pickerIndex = (m.pickerIndex - 1 + len(picker.items)) % len(picker.items)
				return m, nil
			case "down":
				m.pickerIndex = (m.pickerIndex + 1) % len(picker.items)
				return m, nil
			case "tab":
				m.applyPickerItem(picker)
				return m, nil
			case "enter":
				m.applyPickerItem(picker)
				if picker.submitOnEnter {
					return m, m.submitInput(m.textarea.Value())
				}
				return m, nil
			}
		}

		if keyName != "ctrl+c" {
			m.quitConfirmation = false
		}

		// Some tmux and SSH combinations do not preserve bracketed paste, so
		// retain the multi-character newline fallback.
		if text := msg.Key().Text; (strings.Contains(text, "\n") || strings.Contains(text, "\r")) && len(text) > 10 {
			lines := countPasteLines(text)
			if lines >= pastePlaceholderLineThreshold {
				placeholder := fmt.Sprintf("[Pasted text #%d +%d lines]", len(m.pastedTexts)+1, lines)
				m.pastedTexts[placeholder] = text
				m.textarea.InsertString(placeholder)
				return m, nil
			}
		}

		if key.Matches(msg, m.textarea.KeyMap.InsertNewline) {
			var cmd tea.Cmd
			m.textarea, cmd = m.textarea.Update(msg)
			return m, cmd
		}

		switch keyName {
		case "ctrl+c", "esc":
			if m.sess != nil && m.sess.cancelForegroundCommand() {
				return m, nil
			}
			if m.thinking {
				if m.sharedChat != nil {
					return m, m.command("/stop")
				}
				go func() { m.submitted <- "/stop" }()
				return m, nil
			}
			if keyName == "esc" {
				return m, nil
			}
			if m.textarea.Value() != "" {
				m.textarea.Reset()
				m.pastedTexts = make(map[string]string)
				return m, nil
			}
			if m.quitConfirmation {
				return m, tea.Quit
			}
			m.quitConfirmation = true
			return m, tea.Tick(quitConfirmWindow, func(time.Time) tea.Msg {
				return quitConfirmExpiredMsg{}
			})

		case "ctrl+d":
			if m.textarea.Value() == "" {
				return m, tea.Quit
			}

		case "enter":
			return m, m.submitInput(m.textarea.Value())

		case "up":
			if m.atTextareaTop() {
				if m.historyIdx > 0 {
					m.historyIdx--
					m.textarea.SetValue(m.inputHistory[m.historyIdx])
					m.textarea.CursorEnd()
				}
				return m, nil
			}

		case "down":
			if m.atTextareaBottom() {
				if m.historyIdx < len(m.inputHistory)-1 {
					m.historyIdx++
					m.textarea.SetValue(m.inputHistory[m.historyIdx])
					m.textarea.CursorEnd()
				} else if m.historyIdx == len(m.inputHistory)-1 {
					m.historyIdx = len(m.inputHistory)
					m.textarea.Reset()
				}
				return m, nil
			}

		}

	case thinkingMsg:
		wasThinking := m.thinking
		if msg.on {
			m.thinking = true
			if !wasThinking {
				m.runStartedAt = time.Now()
				m.activityNow = m.runStartedAt
			}
			m.thinkingMessage = normalizeActivityText(msg.message)
			m.thinkingTool = msg.tool
			m.textarea.Focus()
			if !wasThinking {
				return m, activityTick()
			}
			return m, nil
		}
		m.clearThinking()
		m.textarea.Focus()
		return m, nil

	case activityTickMsg:
		if !m.thinking {
			return m, nil
		}
		m.activityNow = time.Time(msg)
		return m, activityTick()

	case sessionStatusMsg:
		m.status = msg.status
		return m, nil

	case approvalMsg:
		record := msg.record
		m.approval = &record
		m.approvalResolving = false
		m.approvalScroll = 0
		m.clearThinking()
		return m, nil

	case approvalClearedMsg:
		m.approval = nil
		m.approvalResolving = false
		m.approvalScroll = 0
		m.textarea.Focus()
		return m, nil

	case quitConfirmExpiredMsg:
		m.quitConfirmation = false
		return m, nil

	case tuiOutputMsg:
		return m, m.enqueueTranscript(msg.output)

	case transcriptPrintedMsg:
		m.transcriptPrinting = false
		if len(m.transcriptQueue) > 0 {
			m.transcriptQueue = m.transcriptQueue[1:]
		}
		if len(m.transcriptQueue) == 0 && m.quitAfterTranscript {
			return m, tea.Quit
		}
		if pending := m.pendingAgentInspect; pending != nil {
			m.pendingAgentInspect = nil
			return m, m.openAgentBrowser(pending.prefix)
		}
		return m, m.startTranscriptPrint()

	case agentInspectMsg:
		return m, m.openAgentBrowser(msg.prefix)

	case agentInspectTickMsg:
		if m.agentBrowser != nil {
			return m, agentInspectTick()
		}
		return m, nil

	case agentInspectClosedMsg:
		if msg.generation == m.transcriptResumeGeneration {
			m.transcriptResuming = false
			return m, m.startTranscriptPrint()
		}
		return m, nil

	case agentResultMsg:
		if msg.err != nil && m.approval != nil {
			m.approvalResolving = false
		}
		if !msg.keepThinking {
			m.clearThinking()
		}
		if msg.err != nil {
			if errors.Is(msg.err, context.Canceled) {
				return m, m.enqueueTranscript("■ Stopped by user")
			}
			return m, m.enqueueTranscript(chatErrorStyle.Render("×") + " " + msg.err.Error())
		}
		return m, m.enqueueTranscript(msg.output)

	case quitMsg:
		m.pendingAgentInspect = nil
		m.quitAfterTranscript = true
		m.transcriptQueue = append(m.transcriptQueue, "Bye! 👋")
		return m, m.closeAgentBrowser()
	}

	before := m.textarea.Value()
	var cmd tea.Cmd
	m.textarea, cmd = m.textarea.Update(msg)
	if m.textarea.Value() != before {
		m.pickerClosed = false
		m.pickerIndex = 0
		if m.sharedChat != nil && m.skillsError != "" && !m.skillsLoading && strings.Contains(m.textarea.Value(), "$") {
			cmds = append(cmds, m.loadSharedSettings())
		}
	}
	cmds = append(cmds, cmd)
	return m, tea.Batch(cmds...)
}

// View renders only the fixed bottom surface. At normal heights, the leading
// blank row separates it from transcript content printed into scrollback.
func (m *chatModel) View() tea.View {
	if m.listing {
		return m.viewTopics()
	}
	if m.agentBrowser != nil {
		return m.viewAgentBrowser()
	}
	if m.approval != nil {
		lines := []string{""}
		return tea.NewView(strings.Join(append(lines, m.renderApproval()...), "\n"))
	}
	composer := strings.Split(renderChatTextarea(m.textarea), "\n")
	if m.height > 0 && (m.height < 4 || (m.thinking && len(composer)+2 > m.height)) {
		composer = strings.Split(m.textarea.View(), "\n")
	}
	if m.height > 0 && len(composer) >= m.height {
		return m.fitView(composer)
	}
	picker := m.renderPicker()
	budget := m.height - len(composer) - len(picker) - 1
	lines := make([]string, 0, 8)
	if m.height >= shortTerminalHeight && budget > 0 {
		lines = append(lines, "")
		budget--
	}
	var activity []string
	if m.thinking {
		activity = append(activity, m.renderActivity())
	}
	if m.notice != "" {
		activity = append(activity, chatSecondaryStyle.Render(remoteLine(m.notice)))
	}
	if m.sharedChat != nil {
		if progress := strings.TrimSuffix(m.streamView(), "\n"); progress != "" {
			activity = append(activity, strings.Split(progress, "\n")...)
		}
	}
	if len(activity) > 0 && budget > 0 {
		gap := m.height >= shortTerminalHeight && budget > 1
		if gap {
			budget--
		}
		if len(activity) > budget {
			activity = activity[:budget]
			if !m.thinking || budget > 1 {
				activity[len(activity)-1] = "… progress clipped to terminal height"
			}
		}
		lines = append(lines, activity...)
		if gap {
			lines = append(lines, "")
		}
	}
	lines = append(lines, composer...)
	lines = append(lines, picker...)
	lines = append(lines, m.renderFooter())
	return m.fitView(lines)
}

// fitView clips by terminal cells, not bytes, without breaking ANSI sequences.
func (m *chatModel) fitView(lines []string) tea.View {
	if len(lines) > m.height {
		lines = lines[:m.height]
	}
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, m.width, "…")
	}
	return tea.NewView(strings.Join(lines, "\n"))
}
func (m *chatModel) contentWidth() int {
	if m.width <= 1 {
		return 10
	}
	return max(10, m.width-1)
}

func renderChatTextarea(input textarea.Model) string {
	view := input.View()
	ranges := chatInputHighlightRanges(view, input.Value())
	if len(ranges) > 0 {
		cursorStart, cursorEnd, cursorVisible := chatInputCursorRange(view)
		visible := make([]lipgloss.Range, 0, len(ranges)+1)
		for _, highlight := range ranges {
			if !cursorVisible || cursorEnd <= highlight.Start || cursorStart >= highlight.End {
				visible = append(visible, highlight)
				continue
			}
			if highlight.Start < cursorStart {
				visible = append(visible, lipgloss.NewRange(highlight.Start, cursorStart, highlight.Style))
			}
			if cursorEnd < highlight.End {
				visible = append(visible, lipgloss.NewRange(cursorEnd, highlight.End, highlight.Style))
			}
		}
		ranges = visible
		view = lipgloss.StyleRanges(view, ranges...)
	}
	return chatInputFrameStyle.Render(view)
}

func chatInputHighlightRanges(view string, input string) []lipgloss.Range {
	plain := ansi.Strip(view)
	referenceNames := caprefs.Names(input)
	tokens := make([]string, 0, 1+len(referenceNames))
	if command, _ := chatcommands.ParseCommand(input); chatcommands.NormalizeCommand(command) != "" {
		tokens = append(tokens, command)
	}
	for _, name := range referenceNames {
		tokens = append(tokens, "$"+name)
	}
	sort.SliceStable(tokens, func(i, j int) bool { return len(tokens[i]) > len(tokens[j]) })

	ranges := make([]lipgloss.Range, 0, len(tokens))
	for _, token := range tokens {
		searchFrom := 0
		for searchFrom < len(plain) {
			match := strings.Index(plain[searchFrom:], token)
			if match < 0 {
				break
			}
			match += searchFrom
			start := ansi.StringWidth(plain[:match])
			end := start + ansi.StringWidth(token)
			overlaps := false
			for _, existing := range ranges {
				if start < existing.End && end > existing.Start {
					overlaps = true
					break
				}
			}
			if !overlaps {
				ranges = append(ranges, lipgloss.NewRange(start, end, chatAccentStyle))
			}
			searchFrom = match + len(token)
			if strings.HasPrefix(token, "/") {
				break
			}
		}
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].Start < ranges[j].Start })
	return ranges
}

func chatInputCursorRange(view string) (int, int, bool) {
	const reverseVideo = "\x1b[7m"
	startByte := strings.Index(view, reverseVideo)
	if startByte < 0 {
		return 0, 0, false
	}
	contentStart := startByte + len(reverseVideo)
	contentEnd := strings.Index(view[contentStart:], "\x1b[0m")
	if contentEnd < 0 {
		return 0, 0, false
	}
	contentEnd += contentStart
	width := ansi.StringWidth(view[contentStart:contentEnd])
	if width == 0 {
		return 0, 0, false
	}
	start := ansi.StringWidth(view[:startByte])
	return start, start + width, true
}

func wrapChatTranscript(text string, terminalWidth int) string {
	if terminalWidth <= 1 {
		return text
	}
	return ansi.Hardwrap(text, terminalWidth-1, false)
}

func (m *chatModel) enqueueTranscript(text string) tea.Cmd {
	m.transcriptQueue = append(m.transcriptQueue, text)
	return m.startTranscriptPrint()
}

func (m *chatModel) startTranscriptPrint() tea.Cmd {
	if len(m.transcriptQueue) == 0 || m.transcriptPrinting || m.transcriptResuming || m.agentBrowser != nil {
		return nil
	}
	m.transcriptPrinting = true
	text := wrapChatTranscript(m.transcriptQueue[0], m.width)
	// Bubble Tea inserts transcript output by moving within the visible screen.
	// A block taller than the terminal clamps that cursor movement and displaces
	// the live view. Insert one physical line at a time, keeping the block queued
	// until every line has been printed.
	lines := strings.Split(text, "\n")
	cmds := make([]tea.Cmd, 0, len(lines)+1)
	for _, line := range lines {
		if line == "" {
			line = " " // Bubble Tea skips empty strings rather than inserting a row.
		}
		cmds = append(cmds, tea.Println(line))
	}
	cmds = append(cmds, func() tea.Msg { return transcriptPrintedMsg{} })
	return tea.Sequence(cmds...)
}

func (m *chatModel) clearThinking() {
	m.thinking = false
	m.thinkingMessage = ""
	m.thinkingTool = false
	m.runStartedAt = time.Time{}
	m.activityNow = time.Time{}
}

func (m *chatModel) renderActivity() string {
	width := m.contentWidth()
	detail := normalizeActivityText(m.thinkingMessage)
	now := m.activityNow
	if now.IsZero() {
		now = m.runStartedAt
	}
	frame := chatSpinnerFrames[0]
	elapsed := time.Duration(0)
	if !m.runStartedAt.IsZero() {
		elapsed = max(time.Duration(0), now.Sub(m.runStartedAt))
		frame = chatSpinnerFrames[int(elapsed/activityRefresh)%len(chatSpinnerFrames)]
	}
	parts := []string{chatAccentStyle.Render(frame + " Running")}
	if detail != "" {
		style := chatMutedStyle
		if m.thinkingTool {
			style = chatSecondaryStyle
		}
		parts = append(parts, style.Render(detail))
	}
	if !m.runStartedAt.IsZero() {
		parts = append(parts, chatMutedStyle.Render(formatActivityElapsed(elapsed)))
	}
	return fitChatLine(strings.Join(parts, chatMutedStyle.Render(" · ")), width)
}

func (m *chatModel) renderFooter() string {
	width := m.contentWidth()
	if strings.Contains(m.textarea.Value(), "$") {
		if m.skillsLoading {
			return fitChatLine(chatMutedStyle.Render("  Loading skills…"), width)
		}
		if m.skillsError != "" {
			return fitChatLine(chatWarningStyle.Render("  Skills unavailable; edit the reference to retry"), width)
		}
	}
	if picker := m.picker(); len(picker.items) > 0 {
		enterAction := "run"
		if !picker.submitOnEnter {
			enterAction = "insert"
		}
		return fitChatLine(chatMutedStyle.Render("  ↑↓ select · Tab complete · Enter "+enterAction+" · Esc close"), width)
	}
	if m.quitConfirmation {
		return fitChatLine(chatMutedStyle.Render("  Ctrl+C again to exit"), width)
	}
	left := make([]string, 0, 3)
	if m.status.model != "" {
		left = append(left, m.status.model)
	}
	if name := workspaceDisplayName(m.status.workspace); name != "" {
		left = append(left, name)
	}
	if m.status.contextKnown {
		left = append(left, fmt.Sprintf("ctx %.0f%%", m.status.contextRatio*100))
	}
	if m.status.topic != "" {
		left = append(left, remoteLine(m.status.topic))
	}
	leftText := strings.Join(left, " · ")
	hint := "Ctrl+J newline · / commands"
	if m.thinking {
		hint = "Enter steer · Ctrl+J newline · Esc/Ctrl+C stop"
		if ansi.StringWidth(leftText)+ansi.StringWidth(hint)+5 > width {
			hint = "Enter steer · Ctrl+C stop"
		}
	}
	return chatMutedStyle.Render(joinChatFooter(leftText, hint, width))
}

func (m *chatModel) atTextareaTop() bool {
	info := m.textarea.LineInfo()
	return m.textarea.Line() == 0 && info.RowOffset == 0
}

func (m *chatModel) atTextareaBottom() bool {
	info := m.textarea.LineInfo()
	return m.textarea.Line() == m.textarea.LineCount()-1 && info.RowOffset >= info.Height-1
}

func activityTick() tea.Cmd {
	return tea.Tick(activityRefresh, func(now time.Time) tea.Msg {
		return activityTickMsg(now)
	})
}

func formatActivityElapsed(elapsed time.Duration) string {
	if elapsed < 0 {
		elapsed = 0
	}
	totalSeconds := int(elapsed.Round(time.Second) / time.Second)
	return fmt.Sprintf("%02d:%02d", totalSeconds/60, totalSeconds%60)
}

func normalizeActivityText(text string) string {
	text = strings.TrimSpace(text)
	if text == "" || text == "assistant is thinking..." {
		return "waiting for model"
	}
	return strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ").Replace(text)
}

func joinChatFooter(left, right string, width int) string {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)
	if left == "" {
		return fitChatLine("  "+right, width)
	}
	left = "  " + left
	gap := width - ansi.StringWidth(left) - ansi.StringWidth(right)
	if gap >= 3 {
		return left + strings.Repeat(" ", gap) + right
	}
	// Keep session status visible when there is no room for keyboard hints.
	return fitChatLine(left, width)
}

func fitChatLine(line string, width int) string {
	if width <= 0 || ansi.StringWidth(line) <= width {
		return line
	}
	return ansi.Truncate(line, width, "…")
}

func workspaceDisplayName(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	name := filepath.Base(filepath.Clean(path))
	if name == "." || name == string(filepath.Separator) {
		return ""
	}
	return name
}

func chatSessionStatusFromSession(sess *chatSession) chatSessionStatus {
	if sess == nil {
		return chatSessionStatus{}
	}
	status := chatSessionStatus{
		model:     strings.TrimSpace(sess.mainCfg.Model),
		workspace: strings.TrimSpace(sess.workspaceDir),
	}
	if sess.sharedTopics != nil && sess.topicID != "" {
		if topic, ok := sess.sharedTopics.GetTopic(sess.topicID); ok {
			status.topic = topic.Title
		}
	}
	if sess.topicContextStore == nil {
		return status
	}
	item, found, err := sess.topicContextStore.Get(sess.conversationKey())
	if err == nil && found && item.ContextWindowTokens > 0 {
		status.contextRatio = item.UsageRatio
		status.contextKnown = true
	}
	return status
}

func formatSubmittedInput(input string) string {
	lines := strings.Split(input, "\n")
	for i := range lines {
		if i == 0 {
			lines[i] = chatAccentStyle.Render("❯ ") + lines[i]
		} else {
			lines[i] = "  " + lines[i]
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

func (m *chatModel) submitInput(value string) tea.Cmd {
	raw := strings.TrimSpace(value)
	if raw == "" {
		m.textarea.Reset()
		return nil
	}
	expanded := m.expandPastePlaceholders(raw)
	if m.sharedChat != nil {
		m.pickerClosed = false
		m.pickerIndex = 0
		var cmd tea.Cmd
		localCommand := false
		if strings.HasPrefix(raw, "/") {
			name, _ := chatcommands.ParseCommand(expanded)
			// Task commands keep their draft until the server acknowledges it,
			// just as ordinary messages do.
			if !isSharedTaskCommand(chatcommands.NormalizeCommand(name)) {
				localCommand = true
				m.textarea.Reset()
				m.save()
			}
			cmd = m.command(expanded)
		} else {
			cmd = m.submit(expanded)
		}
		if cmd != nil || localCommand {
			// Paste placeholders belong to a draft; input history crosses topics.
			m.saveHistoryLine(expanded)
			m.inputHistory = append(m.inputHistory, expanded)
			m.historyIdx = len(m.inputHistory)
		}
		return cmd
	}
	if strings.TrimSpace(expanded) == "/topic history more" {
		if m.cursor == "" {
			m.textarea.Reset()
			return nil
		}
		expanded += " " + m.cursor
	}
	go func() { m.submitted <- expanded }()
	m.saveHistoryLine(raw)
	m.inputHistory = append(m.inputHistory, raw)
	m.historyIdx = len(m.inputHistory)
	m.textarea.Reset()
	m.pastedTexts = make(map[string]string)
	m.pickerClosed = false
	m.pickerIndex = 0
	return m.enqueueTranscript(formatSubmittedInput(expanded))
}

func (m *chatModel) picker() chatPicker {
	var picker chatPicker
	if m.pickerClosed {
		return picker
	}

	input := m.textarea.Value()
	if m.commandRegistry != nil && strings.HasPrefix(input, "/") && !strings.ContainsAny(input, " \t\r\n") {
		query := strings.ToLower(input)
		for _, command := range m.commandRegistry.Commands() {
			if strings.HasPrefix(strings.ToLower(command.Name), query) {
				picker.items = append(picker.items, chatPickerItem{
					value:       command.Name,
					description: command.Description,
				})
			}
		}
		picker.replaceEnd = len([]rune(input))
		picker.submitOnEnter = true
	} else if len(m.skillItems) > 0 {
		runes := []rune(input)
		cursor := min(len(runes), textareaCursorOffset(m.textarea))
		start := cursor
		for start > 0 && !unicode.IsSpace(runes[start-1]) {
			start--
		}
		token := runes[start:cursor]
		if len(token) > 0 && token[0] == '$' {
			query := strings.ToLower(string(token[1:]))
			for _, skill := range m.skillItems {
				id := strings.TrimSpace(skill.ID)
				if id == "" {
					id = strings.TrimSpace(skill.Name)
				}
				if id == "" || strings.IndexFunc(id, unicode.IsControl) >= 0 {
					continue
				}
				if query != "" && !strings.Contains(strings.ToLower(id), query) &&
					!strings.Contains(strings.ToLower(skill.Name), query) &&
					!strings.Contains(strings.ToLower(skill.Description), query) {
					continue
				}
				picker.items = append(picker.items, chatPickerItem{
					value:       "$" + id,
					description: strings.TrimSpace(skill.Description),
				})
			}
			picker.replaceStart = start
			picker.replaceEnd = cursor
		}
	}

	if len(picker.items) == 0 {
		m.pickerIndex = 0
	} else if m.pickerIndex >= len(picker.items) {
		m.pickerIndex = len(picker.items) - 1
	}
	return picker
}

func textareaCursorOffset(ta textarea.Model) int {
	lines := strings.Split(ta.Value(), "\n")
	row := min(max(0, ta.Line()), len(lines)-1)
	offset := 0
	for i := 0; i < row; i++ {
		offset += len([]rune(lines[i])) + 1
	}
	lineInfo := ta.LineInfo()
	column := min(len([]rune(lines[row])), lineInfo.StartColumn+lineInfo.ColumnOffset)
	return offset + column
}

func (m *chatModel) applyPickerItem(picker chatPicker) {
	if m.pickerIndex < 0 || m.pickerIndex >= len(picker.items) {
		return
	}
	runes := []rune(m.textarea.Value())
	start := min(max(0, picker.replaceStart), len(runes))
	end := min(max(start, picker.replaceEnd), len(runes))
	insert := []rune(picker.items[m.pickerIndex].value)
	if !picker.submitOnEnter {
		insert = append(insert, ' ')
		if end < len(runes) && runes[end] == ' ' {
			end++
		}
	}

	next := make([]rune, 0, len(runes)-(end-start)+len(insert))
	next = append(next, runes[:start]...)
	next = append(next, insert...)
	cursor := len(next)
	next = append(next, runes[end:]...)
	m.textarea.SetValue(string(next))

	targetRow := 0
	targetColumn := 0
	for _, r := range next[:cursor] {
		if r == '\n' {
			targetRow++
			targetColumn = 0
		} else {
			targetColumn++
		}
	}
	for m.textarea.Line() > targetRow {
		m.textarea.CursorUp()
	}
	for m.textarea.Line() < targetRow {
		m.textarea.CursorDown()
	}
	m.textarea.SetCursorColumn(targetColumn)
	m.pickerIndex = 0
}

func (m *chatModel) renderPicker() []string {
	picker := m.picker()
	if len(picker.items) == 0 {
		return nil
	}
	limit := maxPickerItems
	if m.width < 60 || (m.height > 0 && m.height <= shortTerminalHeight) {
		limit = shortPickerItems
	}
	if m.height > 0 {
		textareaRows := strings.Count(renderChatTextarea(m.textarea), "\n") + 1
		reservedRows := 1 + textareaRows // footer
		if m.height >= shortTerminalHeight {
			reservedRows++ // space above the composer
		}
		if m.thinking {
			reservedRows++
			if m.height >= shortTerminalHeight {
				reservedRows++ // space below activity
			}
		}
		rowsPerItem := 1
		if m.width < 60 && m.height >= shortTerminalHeight {
			rowsPerItem = 2
		}
		limit = min(limit, max(0, m.height-reservedRows)/rowsPerItem)
	}
	if limit == 0 {
		return nil
	}
	start := 0
	if m.pickerIndex >= limit {
		start = m.pickerIndex - limit + 1
	}
	end := min(len(picker.items), start+limit)
	visible := append([]chatPickerItem(nil), picker.items[start:end]...)
	lineBreaks := strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ")
	for i := range visible {
		visible[i].value = lineBreaks.Replace(escapeTerminalControls(visible[i].value))
		visible[i].description = lineBreaks.Replace(escapeTerminalControls(visible[i].description))
	}
	nameWidth := 0
	for _, item := range visible {
		nameWidth = max(nameWidth, ansi.StringWidth(item.value))
	}

	width := m.contentWidth()
	lines := make([]string, 0, len(visible)*2)
	for i, item := range visible {
		selected := start+i == m.pickerIndex
		marker := "  "
		name := item.value
		if selected {
			marker = chatAccentStyle.Render("❯ ")
			name = chatAccentStyle.Render(name)
		}
		if width >= 60 || item.description == "" || (m.height > 0 && m.height < shortTerminalHeight) {
			gap := strings.Repeat(" ", nameWidth-ansi.StringWidth(item.value)+2)
			lines = append(lines, fitChatLine(marker+name+gap+chatMutedStyle.Render(item.description), width))
			continue
		}
		lines = append(lines, fitChatLine(marker+name, width))
		lines = append(lines, fitChatLine("  "+chatMutedStyle.Render(item.description), width))
	}
	return lines
}

func (m *chatModel) renderApproval() []string {
	data := chatApprovalData(*m.approval, m.approvalParams)
	tool := data.tool
	if tool == "" {
		tool = "action"
	}
	width := m.contentWidth()
	title := fitChatLine(chatWarningStyle.Render("! Approval")+" · "+tool, width)
	surfaceHeight := max(1, m.height-1)
	if surfaceHeight == 1 {
		return []string{title}
	}

	body := renderApprovalBody(data, width)
	bodyHeight := max(0, surfaceHeight-2)
	start := min(max(0, len(body)-bodyHeight), max(0, m.approvalScroll))
	end := min(len(body), start+bodyHeight)
	visible := append([]string(nil), body[start:end]...)
	if len(body) <= bodyHeight && len(visible) < bodyHeight {
		visible = append(visible, "")
	}

	footer := "  y approve · n deny · Esc stop"
	if len(body) > bodyHeight && bodyHeight > 0 {
		footer = fmt.Sprintf("  y approve · n deny · Esc stop · ↑↓ %d–%d/%d", start+1, end, len(body))
	}
	lines := make([]string, 0, 2+len(visible))
	lines = append(lines, title)
	lines = append(lines, visible...)
	lines = append(lines, fitChatLine(chatMutedStyle.Render(footer), width))
	return lines
}

func renderApprovalBody(data chatApprovalViewData, width int) []string {
	lines := make([]string, 0, len(data.reasons)+len(data.params)*2)
	for _, reason := range data.reasons {
		lines = append(lines, wrapIndentedChatText(reason, width)...)
	}
	for _, param := range data.params {
		lines = append(lines, "  "+chatMutedStyle.Render(param.name))
		value := param.value
		if param.name == "cmd" {
			prefix := "$ "
			if strings.EqualFold(data.tool, "powershell") {
				prefix = "PS> "
			}
			value = prefix + value
		}
		wrapped := ansi.Hardwrap(value, max(1, width-4), false)
		for _, line := range strings.Split(wrapped, "\n") {
			lines = append(lines, "    "+line)
		}
	}
	if len(data.params) == 0 && data.action != "" {
		lines = append(lines, wrapIndentedChatText(data.action, width)...)
	}
	return lines
}

func (m *chatModel) clampApprovalScroll() {
	if m.approval == nil {
		m.approvalScroll = 0
		return
	}
	bodyHeight := max(0, max(1, m.height-1)-2)
	body := renderApprovalBody(chatApprovalData(*m.approval, m.approvalParams), m.contentWidth())
	m.approvalScroll = min(max(0, m.approvalScroll), max(0, len(body)-bodyHeight))
}

func wrapIndentedChatText(text string, width int) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	wrapped := ansi.Hardwrap(text, max(1, width-inputMarkerWidth), false)
	parts := strings.Split(wrapped, "\n")
	for i := range parts {
		parts[i] = "  " + parts[i]
	}
	return parts
}

func countPasteLines(s string) int {
	if s == "" {
		return 0
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	n := strings.Count(s, "\n")
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

func (m *chatModel) expandPastePlaceholders(s string) string {
	for placeholder, original := range m.pastedTexts {
		s = strings.ReplaceAll(s, placeholder, original)
	}
	return s
}

func (m *chatModel) loadHistory() error {
	path := m.historyPath
	if path == "" {
		if m.sharedChat != nil {
			return nil
		}
		path = filepath.Join(os.Getenv("HOME"), ".mistermorph_chat_history")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			var entry struct {
				Text string `json:"text"`
			}
			if json.Unmarshal([]byte(line), &entry) == nil && entry.Text != "" {
				line = entry.Text
			}
			m.inputHistory = append(m.inputHistory, line)
		}
	}
	m.historyIdx = len(m.inputHistory)
	return nil
}

func (m *chatModel) saveHistoryLine(input string) {
	path := m.historyPath
	if path == "" {
		if m.sharedChat != nil {
			return
		}
		path = filepath.Join(os.Getenv("HOME"), ".mistermorph_chat_history")
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_ = json.NewEncoder(f).Encode(struct {
		Text string `json:"text"`
	}{input})
}

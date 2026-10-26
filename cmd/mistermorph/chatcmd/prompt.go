package chatcmd

import (
	"crypto/ed25519"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate/seal"
)

// A prompt is a card the running task puts to the person: a question (ask_user) or an approval for
// an elevated command, which asks for the sudo password. Local chat and chat attached to a Console
// show the same card; only what an answer does differs (prompt.respond).
//
// The password lives only in chatPrompt.password, a rune buffer the card zeroes once it hands the
// password over or closes. It never reaches the composer, the input history, the transcript or a
// log.

type chatPromptKind uint8

const (
	chatPromptQuestion chatPromptKind = iota
	chatPromptElevation
)

// promptTickInterval refreshes an open card's countdown.
const promptTickInterval = time.Second

type chatPrompt struct {
	key  string
	kind chatPromptKind
	// id is the question's or approval's ID on the runtime; taskID its task (remote).
	id, taskID string

	// A question.
	text    string
	options []taskruntime.UserQuestionOption
	answer  textinput.Model

	// An elevated command.
	command, dir, host string
	attempt            int
	password           []rune
	// offer is the runtime's signed key for a remote approval; nil for a local one.
	offer *seal.Offer

	// deadline is when the card closes by itself; zero when unknown.
	deadline time.Time

	resolving bool
	errText   string

	// respond does what the person answered: hands it to the waiting run (local) or sends it to
	// the runtime (remote). It owns resp.password and must clear it.
	respond func(m *chatModel, p *chatPrompt, resp chatPromptResponse) tea.Cmd
}

// chatPromptResponse is the person's answer to a card.
type chatPromptResponse struct {
	// decline refuses an elevated command, or dismisses a question without an answer.
	decline bool
	// option is the chosen option of a question, or -1 for a typed answer in text.
	option int
	text   string
	// password is the sudo password, for an allowed elevated command.
	password []byte
}

// promptTrust is whether a remote approval may be sent to the runtime that asks for it.
type promptTrust struct {
	// pinned is the identity the answer is sealed for; nil means "the identity the offer names",
	// which is then pinned (a loopback runtime seen the first time).
	pinned ed25519.PublicKey
	// fingerprint is set when the person must first confirm the runtime's fingerprint.
	fingerprint string
	// refusal is set when the password must not be sent at all.
	refusal string
}

type (
	// promptOpenMsg opens a card.
	promptOpenMsg struct{ prompt *chatPrompt }
	// promptExpiredMsg closes a card whose ask ended without an answer.
	promptExpiredMsg struct{ key string }
	promptTickMsg    time.Time
)

func newChatPromptInput() textinput.Model {
	input := textinput.New()
	input.Prompt = ""
	input.Placeholder = "Type an answer"
	styles := input.Styles()
	styles.Focused.Placeholder = chatMutedStyle
	styles.Blurred.Placeholder = chatMutedStyle
	input.SetStyles(styles)
	input.CharLimit = 1500
	input.Focus()
	return input
}

func newQuestionPrompt(key string, q taskruntime.UserQuestion, deadline time.Time) *chatPrompt {
	return &chatPrompt{
		key:      key,
		kind:     chatPromptQuestion,
		id:       q.ID,
		text:     q.Text,
		options:  append([]taskruntime.UserQuestionOption(nil), q.Options...),
		answer:   newChatPromptInput(),
		deadline: deadline,
	}
}

func newElevationPrompt(key, command, dir, host string, deadline time.Time, attempt int) *chatPrompt {
	return &chatPrompt{
		key:      key,
		kind:     chatPromptElevation,
		command:  command,
		dir:      dir,
		host:     host,
		deadline: deadline,
		attempt:  attempt,
	}
}

// clearPassword zeroes the password buffer.
func (p *chatPrompt) clearPassword() {
	clear(p.password)
	p.password = p.password[:0]
}

// takePassword hands the password over as UTF-8 bytes and zeroes the card's copy.
func (p *chatPrompt) takePassword() []byte {
	size := 0
	for _, r := range p.password {
		size += utf8.RuneLen(r)
	}
	out := make([]byte, 0, size)
	for _, r := range p.password {
		out = utf8.AppendRune(out, r)
	}
	p.clearPassword()
	return out
}

func (m *chatModel) activePrompt() *chatPrompt {
	if len(m.prompts) == 0 {
		return nil
	}
	return m.prompts[0]
}

func (m *chatModel) findPrompt(key string) *chatPrompt {
	for _, p := range m.prompts {
		if p.key == key {
			return p
		}
	}
	return nil
}

// openPrompt shows p after the cards already open, unless a card with its key is open or was
// answered here.
func (m *chatModel) openPrompt(p *chatPrompt) tea.Cmd {
	if p == nil || m.findPrompt(p.key) != nil || m.closedPrompts[p.key] {
		return nil
	}
	if len(m.prompts) == 0 {
		m.promptScroll = 0
	}
	m.prompts = append(m.prompts, p)
	m.promptNow = time.Now()
	if m.promptTicking {
		return nil
	}
	m.promptTicking = true
	return promptTick()
}

// closePrompt removes the card with key, remembers it so a later snapshot does not open it again,
// and prints outcome, when given, to the transcript.
func (m *chatModel) closePrompt(key, outcome string) tea.Cmd {
	if m.closedPrompts == nil {
		m.closedPrompts = map[string]bool{}
	}
	m.closedPrompts[key] = true
	return m.dropPrompt(key, outcome)
}

// dropPrompt removes the card with key without remembering it.
func (m *chatModel) dropPrompt(key, outcome string) tea.Cmd {
	for i, p := range m.prompts {
		if p.key != key {
			continue
		}
		p.clearPassword()
		p.answer.Reset()
		m.prompts = append(m.prompts[:i], m.prompts[i+1:]...)
		if i == 0 {
			m.promptScroll = 0
		}
		if m.agentBrowser == nil {
			m.textarea.Focus()
		}
		if outcome == "" {
			return nil
		}
		return m.enqueueTranscript(outcome)
	}
	return nil
}

func promptTick() tea.Cmd {
	return tea.Tick(promptTickInterval, func(now time.Time) tea.Msg { return promptTickMsg(now) })
}

// updatePrompt handles the messages of cards, and keys and pastes while one is shown.
func (m *chatModel) updatePrompt(msg tea.Msg) (tea.Cmd, bool) {
	switch msg := msg.(type) {
	case promptOpenMsg:
		return m.openPrompt(msg.prompt), true
	case promptExpiredMsg:
		p := m.findPrompt(msg.key)
		if p == nil {
			return nil, true
		}
		return m.closePrompt(msg.key, promptOutcome(p, "no answer in time")), true
	case promptTickMsg:
		if len(m.prompts) == 0 {
			m.promptTicking = false
			return nil, true
		}
		m.promptNow = time.Time(msg)
		return promptTick(), true
	case remotePromptResult:
		return m.applyRemotePromptResult(msg), true
	}
	p := m.activePrompt()
	if p == nil || m.listing || m.agentBrowser != nil || m.confirm != "" {
		return nil, false
	}
	switch msg := msg.(type) {
	case tea.PasteMsg:
		m.pastePrompt(p, msg.Content)
		return nil, true
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+g" {
			return nil, false
		}
		return m.promptKey(p, msg), true
	}
	return nil, false
}

func (m *chatModel) pastePrompt(p *chatPrompt, content string) {
	content = strings.TrimRight(content, "\r\n")
	switch p.kind {
	case chatPromptElevation:
		if m.promptTrust(p).fingerprint != "" || p.resolving {
			return
		}
		for _, r := range content {
			if !unicode.IsControl(r) {
				p.password = append(p.password, r)
			}
		}
		p.errText = ""
	case chatPromptQuestion:
		if !p.resolving {
			p.answer.SetValue(p.answer.Value() + strings.Join(strings.Fields(content), " "))
			p.answer.CursorEnd()
		}
	}
}

func (m *chatModel) promptKey(p *chatPrompt, msg tea.KeyPressMsg) tea.Cmd {
	keyName := msg.String()
	switch keyName {
	case "up":
		m.promptScroll = max(0, m.promptScroll-1)
		return nil
	case "down":
		m.promptScroll++
		return nil
	}
	if p.resolving {
		return nil
	}
	if p.kind == chatPromptQuestion {
		return m.questionKey(p, msg)
	}
	return m.elevationKey(p, msg)
}

func (m *chatModel) questionKey(p *chatPrompt, msg tea.KeyPressMsg) tea.Cmd {
	keyName := msg.String()
	typed := strings.TrimSpace(p.answer.Value())
	switch keyName {
	case "esc", "ctrl+c":
		if p.answer.Value() != "" {
			p.answer.Reset()
			return nil
		}
		return p.respond(m, p, chatPromptResponse{decline: true, option: -1})
	case "enter":
		if typed == "" {
			p.errText = "Type an answer or choose an option."
			if len(p.options) == 0 {
				p.errText = "Type an answer, or Esc to dismiss."
			}
			return nil
		}
		p.errText = ""
		return p.respond(m, p, chatPromptResponse{option: -1, text: typed})
	}
	if text := msg.Key().Text; p.answer.Value() == "" && len(text) == 1 && text[0] >= '1' && text[0] <= '9' {
		if index := int(text[0] - '1'); index < len(p.options) {
			p.errText = ""
			return p.respond(m, p, chatPromptResponse{option: index, text: p.options[index].Label})
		}
	}
	p.errText = ""
	var cmd tea.Cmd
	p.answer, cmd = p.answer.Update(msg)
	return cmd
}

func (m *chatModel) elevationKey(p *chatPrompt, msg tea.KeyPressMsg) tea.Cmd {
	keyName := msg.String()
	trust := m.promptTrust(p)
	if keyName == "esc" || keyName == "ctrl+c" {
		p.clearPassword()
		return p.respond(m, p, chatPromptResponse{decline: true})
	}
	if trust.refusal != "" {
		return nil
	}
	if trust.fingerprint != "" {
		switch strings.ToLower(msg.Key().Text) {
		case "y":
			if err := m.pinRuntime(p); err != nil {
				p.errText = "Cannot save the runtime's identity: " + err.Error()
			} else {
				p.errText = ""
			}
		case "n":
			return p.respond(m, p, chatPromptResponse{decline: true})
		}
		return nil
	}
	switch keyName {
	case "enter":
		if len(p.password) == 0 {
			p.errText = "Type the password, or Esc to decline."
			return nil
		}
		p.errText = ""
		return p.respond(m, p, chatPromptResponse{password: p.takePassword()})
	case "backspace", "ctrl+h":
		if len(p.password) > 0 {
			p.password[len(p.password)-1] = 0
			p.password = p.password[:len(p.password)-1]
		}
		return nil
	case "ctrl+u", "ctrl+w":
		p.clearPassword()
		return nil
	}
	if text := msg.Key().Text; text != "" {
		for _, r := range text {
			if !unicode.IsControl(r) {
				p.password = append(p.password, r)
			}
		}
		p.errText = ""
	}
	return nil
}

// promptTrust is how far a remote approval may go; a local one is always trusted.
func (m *chatModel) promptTrust(p *chatPrompt) promptTrust {
	if p == nil || p.kind != chatPromptElevation || p.offer == nil {
		return promptTrust{}
	}
	if m.sharedChat == nil {
		return promptTrust{refusal: "This approval came from a runtime chat is not attached to."}
	}
	return m.remoteTrust(p.offer)
}

// promptOutcome is how a closed card shows in the transcript.
func promptOutcome(p *chatPrompt, outcome string) string {
	if p == nil {
		return ""
	}
	if p.kind == chatPromptQuestion {
		return chatSecondaryStyle.Render("? "+promptLine(p.text, 120)) + "\n" + chatMutedStyle.Render("  "+promptLine(outcome, 200))
	}
	return chatWarningStyle.Render("! Administrator rights") + chatMutedStyle.Render(" · "+promptLine(outcome, 80)+" · $ "+promptLine(p.command, 200))
}

// promptText makes runtime or model text safe to show: control characters escaped, format
// characters (bidi overrides) dropped.
func promptText(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, escapeTerminalControls(strings.TrimSpace(text)))
}

// promptLine is promptText on one line, cut to limit runes.
func promptLine(text string, limit int) string {
	text = strings.Join(strings.Fields(promptText(text)), " ")
	if r := []rune(text); limit > 0 && len(r) > limit {
		return string(r[:limit]) + "…"
	}
	return text
}

func formatPromptCountdown(left time.Duration) string {
	if left < 0 {
		left = 0
	}
	seconds := int(left.Round(time.Second) / time.Second)
	return fmt.Sprintf("%d:%02d left", seconds/60, seconds%60)
}

// renderPrompt draws the active card in the terminal's bottom surface: a title, a body that scrolls
// with ↑↓, the input rows and a footer.
func (m *chatModel) renderPrompt() []string {
	p := m.activePrompt()
	width := m.contentWidth()
	var title string
	var body, input []string
	footer := ""
	switch p.kind {
	case chatPromptQuestion:
		title = chatAccentStyle.Render("? Question")
		body, input, footer = m.renderQuestionPrompt(p, width)
	default:
		title = chatWarningStyle.Render("! Administrator rights needed")
		if host := promptLine(p.host, 60); host != "" {
			title += chatMutedStyle.Render(" · on " + host)
		}
		body, input, footer = m.renderElevationPrompt(p, width)
	}
	if more := len(m.prompts) - 1; more > 0 {
		title += chatMutedStyle.Render(fmt.Sprintf(" · %d more waiting", more))
	}
	if !p.deadline.IsZero() {
		now := m.promptNow
		if now.IsZero() {
			now = time.Now()
		}
		footer += " · " + formatPromptCountdown(p.deadline.Sub(now))
	}
	if p.resolving {
		footer = "  Sending…"
	}
	title = fitChatLine(title, width)
	surfaceHeight := max(1, m.height-1)
	if surfaceHeight <= len(input)+1 {
		return append([]string{title}, input...)[:min(surfaceHeight, len(input)+1)]
	}
	bodyHeight := max(0, surfaceHeight-2-len(input))
	start := min(max(0, len(body)-bodyHeight), max(0, m.promptScroll))
	m.promptScroll = start
	end := min(len(body), start+bodyHeight)
	if len(body) > bodyHeight && bodyHeight > 0 {
		footer += fmt.Sprintf(" · ↑↓ %d–%d/%d", start+1, end, len(body))
	}
	lines := make([]string, 0, surfaceHeight)
	lines = append(lines, title)
	lines = append(lines, body[start:end]...)
	lines = append(lines, input...)
	lines = append(lines, fitChatLine(chatMutedStyle.Render(footer), width))
	return lines
}

func (m *chatModel) renderQuestionPrompt(p *chatPrompt, width int) (body, input []string, footer string) {
	body = append(body, wrapPromptParagraph(promptText(p.text), width)...)
	for i, option := range p.options {
		label := promptLine(option.Label, 80)
		line := "  " + chatAccentStyle.Render(strconv.Itoa(i+1)+".") + " " + label
		if detail := promptLine(option.Description, 200); detail != "" {
			line += chatMutedStyle.Render(" — " + detail)
		}
		for _, row := range strings.Split(ansi.Hardwrap(line, max(1, width), false), "\n") {
			body = append(body, row)
		}
	}
	body = append(body, "")
	p.answer.SetWidth(max(1, width-inputMarkerWidth-1))
	input = append(input, chatAccentStyle.Render("❯ ")+p.answer.View())
	if p.errText != "" {
		input = append(input, fitChatLine("  "+chatErrorStyle.Render(promptLine(p.errText, 200)), width))
	}
	footer = "  type an answer · Enter send · Esc dismiss"
	if n := len(p.options); n > 0 {
		footer = fmt.Sprintf("  1–%d choose · type an answer · Enter send · Esc dismiss", n)
	}
	return body, input, footer
}

func (m *chatModel) renderElevationPrompt(p *chatPrompt, width int) (body, input []string, footer string) {
	trust := m.promptTrust(p)
	if p.attempt >= 2 {
		body = append(body, "  "+chatErrorStyle.Render("The password was not accepted. Try again."))
	}
	body = append(body, "  "+chatMutedStyle.Render("command"))
	for _, row := range strings.Split(ansi.Hardwrap("$ "+promptText(p.command), max(1, width-4), false), "\n") {
		body = append(body, "    "+row)
	}
	if dir := promptText(p.dir); dir != "" {
		body = append(body, "  "+chatMutedStyle.Render("in"))
		for _, row := range strings.Split(ansi.Hardwrap(dir, max(1, width-4), false), "\n") {
			body = append(body, "    "+row)
		}
	}
	body = append(body, "")
	switch {
	case trust.refusal != "":
		body = append(body, wrapPromptParagraph(trust.refusal, width)...)
		input = append(input, fitChatLine("  "+chatErrorStyle.Render("Not sending the password."), width))
		footer = "  Esc decline"
	case trust.fingerprint != "":
		body = append(body, wrapPromptParagraph("This runtime has not been approved from chat before. Check that its fingerprint matches what `mistermorph console fingerprint` prints on the runtime's machine:", width)...)
		body = append(body, "    "+chatAccentStyle.Render(trust.fingerprint))
		input = append(input, fitChatLine("  Does it match? "+chatAccentStyle.Render("y")+" yes · "+chatAccentStyle.Render("n")+" no", width))
		footer = "  y trust and continue · n/Esc decline"
	default:
		masked := strings.Repeat("•", min(len(p.password), max(1, width-14)))
		input = append(input, fitChatLine("  Password  "+masked+chatAccentStyle.Render("▏"), width))
		footer = "  Enter allow · Esc decline"
	}
	if p.errText != "" {
		input = append(input, fitChatLine("  "+chatErrorStyle.Render(promptLine(p.errText, 300)), width))
	}
	return body, input, footer
}

// wrapPromptParagraph wraps text at word boundaries (long words are broken), indented like the
// card's other rows.
func wrapPromptParagraph(text string, width int) []string {
	var lines []string
	for _, paragraph := range strings.Split(strings.TrimSpace(text), "\n") {
		wrapped := ansi.Wrap(strings.TrimSpace(paragraph), max(1, width-inputMarkerWidth), "")
		for _, row := range strings.Split(wrapped, "\n") {
			lines = append(lines, "  "+row)
		}
	}
	return lines
}

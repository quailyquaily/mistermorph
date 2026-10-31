package coderterm

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// codexBackend drives the Codex TUI and reads sessions/YYYY/MM/DD/rollout-*-<id>.jsonl.
type codexBackend struct{}

func (codexBackend) label() string { return "Codex" }

// Codex picks its own session ID; it is read from /status before the first task.
func (codexBackend) newID() string { return "" }

func (codexBackend) args(id string, resume bool) []string {
	// --no-daemon keeps the session out of a shared app-server. Approvals reach the user;
	// writes stay in the workspace sandbox unless the user approves more.
	flags := []string{"--no-daemon", "-c", "check_for_update_on_startup=false",
		"--ask-for-approval", "on-request", "--sandbox", "workspace-write"}
	if resume {
		// codex resume reopens the thread and appends to the same rollout file.
		return append([]string{"resume", id}, flags...)
	}
	return flags
}

func (codexBackend) transcriptRoot(getenv func(string) string, home, cwd string) string {
	return filepath.Join(configDir(getenv, "CODEX_HOME", home, ".codex", cwd), "sessions")
}

func (codexBackend) findTranscript(root, id string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(root, "*", "*", "*", "rollout-*-"+id+".jsonl"))
	if err != nil || len(matches) == 0 {
		return "", err
	}
	if len(matches) > 1 {
		return "", fmt.Errorf("Codex has %d session files for %s", len(matches), id)
	}
	return matches[0], nil
}

var codexSession = regexp.MustCompile(`Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`)

func (codexBackend) sessionID(screen string) string {
	if match := codexSession.FindStringSubmatch(screen); match != nil {
		return match[1]
	}
	return ""
}

func (codexBackend) parse(screen string) screenView { return parseCodexScreen(screen) }

func (codexBackend) newTurn(path string, offset int64, expected string) turnReader {
	return &codexTurn{path: path, offset: offset, expected: expected}
}

// Codex records a declined approval as an aborted turn, so the call ends there.
func (codexBackend) declined(view screenView, a Answer) (bool, bool) {
	q := view.question
	return a.Option >= 0 && a.Option < len(q.Options) && strings.HasPrefix(q.Options[a.Option], "No"), false
}

var (
	codexOption   = regexp.MustCompile(`^(?:› )?([1-9][0-9]*)\. (.*)$`)
	codexShortcut = regexp.MustCompile(` \((?:[a-z]|esc)\)$`)
	// Lines that start a TUI history cell; an approval's description never begins with one.
	codexHistory = []string{"•", "›", "✔", "✗", "■", "└", "─"}
)

// parseCodexScreen recognizes the bottom approval or trust prompt and the idle composer.
func parseCodexScreen(screen string) screenView {
	lines := strings.Split(screen, "\n")
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], " ")
	}
	last := len(lines) - 1
	for last >= 0 && strings.TrimSpace(lines[last]) == "" {
		last--
	}
	if last < 0 {
		return screenView{}
	}
	footer := strings.TrimSpace(lines[last])
	if strings.HasPrefix(footer, "Press enter to confirm") {
		return parseCodexPrompt(lines[:last]) // A digit selects and confirms.
	}
	if strings.HasPrefix(footer, "enter continue") {
		// The trust prompt: a digit only moves the highlight.
		v := parseCodexPrompt(lines[:last])
		v.selectThenEnter = v.question != nil
		return v
	}
	for _, line := range lines {
		if strings.Contains(line, "esc to interrupt") {
			return screenView{}
		}
	}
	// The composer sits just above the footer; while working, a status line names esc.
	for i := last; i >= max(0, last-5); i-- {
		if strings.HasPrefix(lines[i], "› ") {
			return screenView{idle: true}
		}
	}
	return screenView{}
}

func parseCodexPrompt(lines []string) screenView {
	end := len(lines) - 1
	for end >= 0 && strings.TrimSpace(lines[end]) == "" {
		end--
	}
	start := end
	for start > 0 && strings.TrimSpace(lines[start-1]) != "" {
		start--
	}
	q := &Question{ChoicesOnly: true}
	v := screenView{question: q, immediate: true, selected: -1}
	for _, raw := range lines[start : end+1] {
		line := strings.TrimSpace(raw)
		if match := codexOption.FindStringSubmatch(line); match != nil {
			if strings.HasPrefix(line, "› ") {
				v.selected = len(q.Options)
			}
			v.keys = append(v.keys, match[1])
			q.Options = append(q.Options, match[2])
		} else if len(q.Options) > 0 {
			// Long option labels wrap at the terminal width.
			q.Options[len(q.Options)-1] += " " + line
		}
	}
	if len(q.Options) == 0 {
		return screenView{problem: "Codex presented an unsupported prompt"}
	}
	for i, option := range q.Options {
		// The digit selects and confirms; the letter shortcut is noise on a card.
		q.Options[i] = codexShortcut.ReplaceAllString(option, "")
		if v.keys[i] != strconv.Itoa(i+1) {
			return screenView{problem: "Codex prompt options are out of order"}
		}
	}
	// The description sits above the options; two blank lines separate it from history.
	var description []string
	blank := 0
	i := start - 1
	for i >= 0 && strings.TrimSpace(lines[i]) == "" {
		i--
	}
	for ; i >= 0; i-- {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			if blank++; blank == 2 {
				break
			}
			continue
		}
		if hasAnyPrefix(line, codexHistory) {
			break
		}
		blank = 0
		description = append([]string{strings.TrimSpace(line)}, description...)
	}
	q.Text = strings.Join(description, "\n")
	return v
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	return false
}

// codexTurn follows the rollout from the submitted user message to its task_complete.
// Codex adds its own user-role context messages, so only the exact task text marks the turn.
type codexTurn struct {
	path     string
	offset   int64
	expected string
	started  string // The latest task_started turn.
	turnID   string // The turn that carries our task.
	output   string
	done     bool
	err      error
}

func (r *codexTurn) state() (string, bool, error) { return r.output, r.done, r.err }

func (r *codexTurn) read() error {
	f, err := os.Open(r.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Seek(r.offset, io.SeekStart); err != nil {
		return err
	}
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			return nil // A partial last line waits for the next read.
		}
		if err != nil {
			return err
		}
		r.offset += int64(len(line))
		var entry struct {
			Type    string `json:"type"`
			Payload struct {
				Type    string `json:"type"`
				TurnID  string `json:"turn_id"`
				Role    string `json:"role"`
				Reason  string `json:"reason"`
				Last    string `json:"last_agent_message"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(line, &entry); err != nil {
			return err
		}
		p := entry.Payload
		switch {
		case entry.Type == "event_msg" && p.Type == "task_started":
			r.started = p.TurnID
		case entry.Type == "response_item" && p.Type == "message" && p.Role == "user" && r.turnID == "":
			var parts []string
			for _, block := range p.Content {
				if block.Type == "input_text" {
					parts = append(parts, block.Text)
				}
			}
			if strings.Join(parts, "\n") == r.expected {
				if r.started == "" {
					return fmt.Errorf("Codex recorded the task outside a turn")
				}
				r.turnID = r.started
			}
		case r.turnID == "" || p.TurnID != r.turnID:
		case entry.Type == "event_msg" && p.Type == "task_complete":
			r.done = true
			switch {
			case p.Error != nil:
				r.err = fmt.Errorf("Codex: %s", p.Error.Message)
			case strings.TrimSpace(p.Last) == "":
				r.output = noTextReply
			default:
				r.output = p.Last
			}
		case entry.Type == "event_msg" && p.Type == "turn_aborted":
			r.err = fmt.Errorf("Codex stopped the turn: %s", p.Reason)
		}
	}
}

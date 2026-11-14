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
	"time"
)

// codexBackend drives the Codex TUI and reads sessions/YYYY/MM/DD/rollout-*-<id>.jsonl.
type codexBackend struct{}

func (codexBackend) label() string { return "Codex" }

// Codex picks its own session ID; it is read from /status before the first task.
func (codexBackend) newID() string { return "" }

func (codexBackend) args(id string, resume, bypass bool, _ string) []string {
	// --no-daemon keeps the session out of a shared app-server. Approvals reach the user;
	// writes stay in the workspace sandbox unless the user approves more. With bypass, Codex
	// runs every command without asking and without a sandbox (yolo mode).
	flags := []string{"--no-daemon", "-c", "check_for_update_on_startup=false",
		"--ask-for-approval", "on-request", "--sandbox", "workspace-write"}
	if bypass {
		flags = []string{"--no-daemon", "-c", "check_for_update_on_startup=false",
			"--dangerously-bypass-approvals-and-sandbox"}
	}
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
	// path is <sessions>/YYYY/MM/DD/rollout-*.jsonl; sub-agents' rollouts are under the same sessions.
	root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(path))))
	// The name is rollout-YYYY-MM-DDThh-mm-ss-<thread ID>.jsonl.
	var thread string
	if name := strings.TrimSuffix(filepath.Base(path), ".jsonl"); len(name) > len("rollout-2006-01-02T15-04-05-") {
		thread = name[len("rollout-2006-01-02T15-04-05-"):]
	}
	return &codexTurn{path: path, offset: offset, expected: expected, root: root, thread: thread}
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

// codexTurn follows the rollout from the submitted user message to its task_complete, and then
// until the sub-agents Codex started for the task are idle. Codex adds its own user-role context
// messages, so only the exact task text marks the turn.
//
// Codex can complete its turn while sub-agents it started still work, and it does not take
// another turn when they finish unless its wake_on_agent_messages feature is on. So the task is
// done once every sub-agent, nested ones too, has no turn open in its own rollout, and neither
// has the parent. The reply is that of the last turn the parent took, ours or one it took by
// itself since, followed by the results of the sub-agents that finished after that reply.
type codexTurn struct {
	path     string
	offset   int64
	expected string
	started  string // The latest task_started turn.
	turnID   string // The turn that carries our task.
	output   string
	done     bool // Our turn completed.
	err      error

	root   string // The sessions folder, where each sub-agent keeps its own rollout.
	thread string // This session's thread ID: sub-agents message it too, and it is no sub-agent.
	now    func() time.Time
	agents []*codexAgent
	// woke is the latest turn the parent took by itself after ours; woken is that it has ended.
	woke     string
	woken    bool
	answer   string    // the reply of the last turn that gave one: ours, or a later one of the parent's
	answered time.Time // when the rollout recorded it
}

// codexAgentGrace is how long a sub-agent counts as busy after it is started or messaged before
// its rollout shows the turn: Codex may create the file late, and a message need not start one.
const codexAgentGrace = time.Minute

// codexAgent is one sub-agent: its rollout, read as it grows.
type codexAgent struct {
	id, path string // thread ID, and the agent path Codex gives it, such as /root/review
	file     string
	offset   int64
	inTurn   bool
	nudged   time.Time // when it was last started or messaged without a turn seen since
	late     string    // its latest reply recorded after the parent's, which the parent has not seen
	lateAt   time.Time // when its rollout recorded that reply
}

// name is the agent path Codex gives it, or its thread ID when the rollout recorded none.
func (a *codexAgent) name() string {
	if a.path != "" {
		return a.path
	}
	return a.id
}

func (a *codexAgent) busy(now time.Time) bool {
	return a.inTurn || (!a.nudged.IsZero() && now.Sub(a.nudged) < codexAgentGrace)
}

func (r *codexTurn) clock() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

func (r *codexTurn) state() (string, bool, error) {
	if r.err != nil || !r.done {
		return r.output, false, r.err
	}
	now := r.clock()
	if r.woke != "" && !r.woken {
		return r.output, false, nil
	}
	for _, a := range r.agents {
		if a.busy(now) {
			return r.output, false, nil
		}
	}
	var parts []string
	for _, a := range r.agents {
		if late := strings.TrimSpace(a.late); late != "" {
			parts = append(parts, fmt.Sprintf("[Sub-agent %s finished after this reply]\n%s", a.name(), late))
		}
	}
	if len(parts) == 0 {
		return r.answer, true, nil
	}
	if r.answer != noTextReply {
		// The sub-agents' results are the text when the parent gave none.
		parts = append([]string{r.answer}, parts...)
	}
	return strings.Join(parts, "\n\n"), true, nil
}

// codexEntry is the part of a rollout line this reader uses.
type codexEntry struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
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
		// sub_agent_activity
		Kind   string `json:"kind"`
		Agent  string `json:"agent_thread_id"`
		AgPath string `json:"agent_path"`
	} `json:"payload"`
}

func (e codexEntry) at() time.Time {
	t, _ := time.Parse(time.RFC3339Nano, e.Timestamp)
	return t
}

// readLines hands each complete line after offset to fn and advances offset past it.
func readLines(path string, offset *int64, fn func(codexEntry) error) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Seek(*offset, io.SeekStart); err != nil {
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
		*offset += int64(len(line))
		var entry codexEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			return err
		}
		if err := fn(entry); err != nil {
			return err
		}
	}
}

// noteAgent takes a sub_agent_activity: "started" and "interacted" (a message or follow-up sent
// to it) mean it may take a turn; "completed" is sent only on a best effort, so the agent's own
// rollout decides when it is idle.
func (r *codexTurn) noteAgent(entry codexEntry) {
	p := entry.Payload
	if entry.Type != "event_msg" || p.Type != "sub_agent_activity" || p.Agent == "" || p.Agent == r.thread {
		return
	}
	if p.Kind != "started" && p.Kind != "interacted" {
		return
	}
	for _, a := range r.agents {
		if a.id == p.Agent {
			a.nudged = r.clock()
			if a.path == "" {
				a.path = p.AgPath
			}
			return
		}
	}
	r.agents = append(r.agents, &codexAgent{id: p.Agent, path: p.AgPath, nudged: r.clock()})
}

func (r *codexTurn) read() error {
	err := readLines(r.path, &r.offset, func(entry codexEntry) error {
		p := entry.Payload
		switch {
		case entry.Type == "event_msg" && p.Type == "task_started":
			r.started = p.TurnID
			if r.done && p.TurnID != r.turnID {
				// Each sub-agent's report can wake the parent, so the latest turn is the one to wait for.
				r.woke, r.woken = p.TurnID, false
			}
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
		case r.turnID == "":
		case entry.Type == "event_msg" && p.Type == "sub_agent_activity":
			r.noteAgent(entry)
		case r.woke != "" && p.TurnID == r.woke && entry.Type == "event_msg" &&
			(p.Type == "task_complete" || p.Type == "turn_aborted"):
			// The parent's own turn after ours, woken by its sub-agents: its reply is the newer one.
			r.woken = true
			if p.Type == "task_complete" && p.Error == nil && strings.TrimSpace(p.Last) != "" {
				r.output, r.answer, r.answered = p.Last, p.Last, entry.at()
				// The parent has seen what its sub-agents replied before this.
				for _, a := range r.agents {
					if !a.lateAt.IsZero() && !a.lateAt.After(r.answered) {
						a.late = ""
					}
				}
			}
		case p.TurnID != r.turnID:
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
			r.answer = r.output
			r.answered = entry.at()
		case entry.Type == "event_msg" && p.Type == "turn_aborted":
			r.err = fmt.Errorf("Codex stopped the turn: %s", p.Reason)
		}
		return nil
	})
	if err != nil || r.turnID == "" || r.root == "" {
		return err
	}
	// The slice grows while it is read: a sub-agent's own sub-agents join it.
	for i := 0; i < len(r.agents); i++ {
		if err := r.readAgent(r.agents[i]); err != nil {
			return err
		}
	}
	return nil
}

func (r *codexTurn) readAgent(a *codexAgent) error {
	if a.file == "" {
		if r.clock().Sub(a.nudged) >= codexAgentGrace {
			return nil // Never written: Codex keeps no rollout for some sub-agents, so stop looking.
		}
		file, err := codexBackend{}.findTranscript(r.root, a.id)
		if err != nil || file == "" {
			return nil // Not written yet; the grace keeps it busy meanwhile.
		}
		a.file = file
	}
	return readLines(a.file, &a.offset, func(entry codexEntry) error {
		p := entry.Payload
		if entry.Type != "event_msg" {
			return nil
		}
		switch p.Type {
		case "task_started":
			a.inTurn, a.nudged = true, time.Time{}
		case "task_complete", "turn_aborted":
			a.inTurn = false
			// One read can reach our reply before a sub-agent's earlier one, so the times decide.
			at := entry.at()
			if p.Type == "task_complete" && p.Error == nil && r.done &&
				(at.IsZero() || r.answered.IsZero() || at.After(r.answered)) {
				a.late, a.lateAt = p.Last, at
			}
		case "sub_agent_activity":
			r.noteAgent(entry)
		}
		return nil
	})
}

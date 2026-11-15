package codersessions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

// claudeNoTextReply is the answer of a task that ended without one.
const claudeNoTextReply = "Claude Code finished this task without a text reply."

// What Claude Code is doing, as short labels without content.
const (
	claudeStepStarting = "starting up"
	claudeStepThinking = "thinking"
	claudeStepCommand  = "running a command"
	claudeStepEdit     = "editing files"
	claudeStepRead     = "reading code"
	claudeStepWeb      = "searching the web"
	claudeStepTool     = "calling a tool"
	claudeStepPlan     = "planning"
	claudeStepSubagent = "running a subagent"
	claudeStepQuestion = "waiting for an answer"
)

const (
	claudeActivityMax = 1000
	claudeNoteMax     = 2000
)

// claudeArgs is the command line of a session's process: JSON lines in and out, permission
// prompts sent to the host over them, and the session kept on disk so it can be reopened.
func claudeArgs(id string, resume, bypass bool) []string {
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-prompt-tool", "stdio",
	}
	if resume {
		args = append(args, "--resume", id)
	} else {
		args = append(args, "--session-id", id)
	}
	if bypass {
		return append(args, "--dangerously-skip-permissions")
	}
	return append(args, "--permission-mode", "default")
}

// claude runs one task in the session's `claude -p` process, starting or reopening it first. A
// task is one user line on stdin; it ends with its `result` line, and the process waits for the
// next task.
func (s *session) claude(ctx context.Context, req Request) (output string, run coderusage.Run, quota *coderusage.Quota, err error) {
	run.Backend = coderusage.BackendClaude
	task := &claudeTask{s: s, req: req}
	started := false
	if s.rpc == nil {
		// A session that never got as far as a reply may not be on disk: it starts over.
		resume := s.id != "" && s.resumable
		if !resume {
			s.id, s.resumable = uuid.NewString(), false
		}
		s.rpc, err = startProcess(req, true, claudeArgs(s.id, resume, req.BypassApprovals)...)
		if err != nil {
			return
		}
		started = true
	} else {
		task.between()
	}
	if req.Process != nil {
		req.Process(s.rpc.cmd.Process.Pid)
	}
	heard := false
	defer func() {
		output, run.Models, run.Turns, quota = task.answer(), task.models, task.turns, task.quota
		if err == nil && output == "" {
			output = claudeNoTextReply
		}
		// A process that ended by itself without a line could not open the session (a reopened
		// one whose file is gone, say): the next task starts a new one instead of failing again.
		if err != nil && ctx.Err() == nil && started && !heard {
			s.id, s.resumable = "", false
		}
	}()
	line := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": req.Task}}
	if err = s.rpc.sendCtx(ctx, line); err != nil {
		return
	}
	for {
		m, e := s.rpc.read(ctx)
		if e != nil {
			err = e
			return
		}
		heard = true
		done, e := task.line(ctx, m.line)
		if e != nil {
			err = e
			return
		}
		if done {
			err = task.failure
			return
		}
	}
}

// claudeTask reads the lines of one task. Nothing of it outlives the task: the answer, the
// progress and the usage of the task before are not this one's.
type claudeTask struct {
	s   *session
	req Request

	step string
	// text is the last message Claude Code wrote, not said as a note yet: its reply when the
	// task ends there, a note when it goes on working after it.
	text   string
	result string
	tools  map[string]string // tool use ID to tool name

	models  []coderusage.ModelUsage
	turns   int
	quota   *coderusage.Quota
	failure error
}

func (t *claudeTask) answer() string {
	if t.result != "" {
		return t.result
	}
	return t.text
}

// between takes what the process wrote since its last task ended: lines of that task that came
// after its result. They are not the new task's, except the quota, which is the newest known.
func (t *claudeTask) between() {
	for {
		select {
		case m, ok := <-t.s.rpc.messages:
			if !ok {
				return
			}
			var p map[string]any
			if json.Unmarshal(m.line, &p) != nil {
				continue
			}
			switch claudeString(p, "type") {
			case "rate_limit_event":
				t.rateLimit(p)
			case "control_request":
				_ = t.respond(p, map[string]any{"behavior": "deny", "message": "No task is running."})
			}
		default:
			return
		}
	}
}

// line reads one line of the stream. done says the task's result arrived.
func (t *claudeTask) line(ctx context.Context, line []byte) (done bool, err error) {
	var p map[string]any
	if json.Unmarshal(line, &p) != nil {
		return false, nil
	}
	switch claudeString(p, "type") {
	case "system":
		switch {
		case claudeString(p, "subtype") == "init":
			t.setStep(claudeStepStarting)
		case claudeString(p, "status") == "requesting":
			t.setStep(claudeStepThinking)
		}
	case "tool_progress":
		t.setStep(claudeToolStep(claudeString(p, "tool_name")))
	case "stream_event":
		event, _ := p["event"].(map[string]any)
		block, _ := event["content_block"].(map[string]any)
		switch claudeString(block, "type") {
		case "tool_use":
			t.setStep(claudeToolStep(claudeString(block, "name")))
		case "thinking":
			t.setStep(claudeStepThinking)
		}
	case "assistant", "user":
		t.message(p)
	case "rate_limit_event":
		t.rateLimit(p)
	case "control_request":
		return false, t.control(ctx, p)
	case "result":
		t.finish(p)
		return true, nil
	}
	return false, nil
}

// message reads an assistant message or the tool results that answer it. A sub-agent's messages
// (parent_tool_use_id) show what is being done, but its text is not Claude Code's reply.
func (t *claudeTask) message(p map[string]any) {
	assistant := claudeString(p, "type") == "assistant"
	_, subagent := p["parent_tool_use_id"].(string)
	message, _ := p["message"].(map[string]any)
	blocks, _ := message["content"].([]any)
	if assistant && !subagent && len(blocks) > 0 {
		// The session is on disk once Claude Code has replied in it.
		t.s.resumable = true
	}
	for _, value := range blocks {
		block, ok := value.(map[string]any)
		if !ok {
			continue
		}
		switch claudeString(block, "type") {
		case "text":
			if text := claudeString(block, "text"); assistant && !subagent && text != "" {
				t.say()
				t.text = text
			}
		case "tool_use":
			name := claudeString(block, "name")
			if t.tools == nil {
				t.tools = map[string]string{}
			}
			t.tools[claudeString(block, "id")] = name
			if !subagent {
				t.say()
			}
			t.setStep(claudeToolStep(name))
			input, _ := json.Marshal(block["input"])
			t.activity("[claude] " + name + " " + string(input))
		case "tool_result":
			name := t.tools[claudeString(block, "tool_use_id")]
			if name == "" {
				name = "tool"
			}
			status := "completed"
			if failed, _ := block["is_error"].(bool); failed {
				status = "failed"
			}
			t.setStep(claudeStepThinking)
			t.activity("[claude] " + name + " " + status + " " + claudeText(block["content"]))
		}
	}
}

// say hands over, as a note, the message Claude Code wrote before it went on working.
func (t *claudeTask) say() {
	if t.text != "" {
		note(t.req, clip(t.text, claudeNoteMax))
		t.text = ""
	}
}

func (t *claudeTask) activity(text string) {
	note(t.req, clip(strings.TrimSpace(text), claudeActivityMax))
}

func (t *claudeTask) setStep(step string) {
	if step != "" && step != t.step {
		t.step = step
		progress(t.req, step)
	}
}

func (t *claudeTask) rateLimit(p map[string]any) {
	info, _ := p["rate_limit_info"].(map[string]any)
	if quota, ok := coderusage.ParseClaudeRateLimit(info, time.Now()); ok {
		t.quota = &quota
	}
}

// finish reads the task's result line: its answer, whether it failed, and what it used.
func (t *claudeTask) finish(p map[string]any) {
	t.models, t.turns = coderusage.ClaudeTaskUsage(p)
	if id := claudeString(p, "session_id"); id != "" {
		t.s.id = id
	}
	t.s.resumable = true
	t.result = claudeString(p, "result")
	if failed, _ := p["is_error"].(bool); !failed {
		return
	}
	detail := t.result
	if detail == "" {
		detail = claudeString(p, "error")
	}
	if detail == "" {
		errors, _ := json.Marshal(p["errors"])
		detail = claudeString(p, "subtype") + ": " + string(errors)
	}
	t.failure = fmt.Errorf("claude failed: %s", detail)
}

// control answers a request Claude Code puts to its host. The one it is started to send is
// can_use_tool: a permission prompt, or its own question to the user (the AskUserQuestion tool).
func (t *claudeTask) control(ctx context.Context, p map[string]any) error {
	request, _ := p["request"].(map[string]any)
	if claudeString(request, "subtype") != "can_use_tool" {
		return t.s.rpc.send(map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "error", "request_id": p["request_id"], "error": "unsupported request: " + claudeString(request, "subtype"),
		}})
	}
	tool := claudeString(request, "tool_name")
	input, _ := request["input"].(map[string]any)
	if input == nil {
		input = map[string]any{}
	}
	if tool == "AskUserQuestion" {
		answers, err := t.questions(ctx, input)
		if err != nil {
			return err
		}
		updated := make(map[string]any, len(input)+1)
		for key, value := range input {
			updated[key] = value
		}
		updated["answers"] = answers
		return t.respond(p, map[string]any{"behavior": "allow", "updatedInput": updated})
	}
	allow := t.req.BypassApprovals
	if !allow {
		previous := t.step
		t.setStep(claudeStepQuestion)
		a, err := ask(ctx, t.req, Question{Text: claudePermissionText(tool, claudeString(request, "description"), input), Options: []string{"Allow once", "Deny"}, ChoicesOnly: true})
		if err != nil {
			return err
		}
		if a.Option != 0 && a.Option != 1 {
			return fmt.Errorf("invalid Claude Code approval choice")
		}
		allow = a.Option == 0
		t.setStep(previous)
	}
	if !allow {
		// A denied action does not end the task: Claude Code goes on and says what it could not do.
		return t.respond(p, map[string]any{"behavior": "deny", "message": "The user denied this action."})
	}
	return t.respond(p, map[string]any{"behavior": "allow", "updatedInput": input})
}

func (t *claudeTask) respond(p map[string]any, response map[string]any) error {
	return t.s.rpc.send(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": p["request_id"], "response": response,
	}})
}

// questions puts the questions of an AskUserQuestion call to the user, one card each, and
// returns the answers by question, as the tool takes them.
func (t *claudeTask) questions(ctx context.Context, input map[string]any) (map[string]string, error) {
	list, _ := input["questions"].([]any)
	answers := map[string]string{}
	for _, value := range list {
		item, _ := value.(map[string]any)
		text := claudeString(item, "question")
		if text == "" {
			continue
		}
		q := Question{Text: text}
		if header := claudeString(item, "header"); header != "" {
			q.Text = header + ": " + text
		}
		options, _ := item["options"].([]any)
		for _, value := range options {
			option, _ := value.(map[string]any)
			label := claudeString(option, "label")
			if label == "" {
				continue
			}
			q.Options = append(q.Options, label)
			if description := claudeString(option, "description"); description != "" {
				q.Text += "\n- " + label + ": " + description
			}
		}
		t.setStep(claudeStepQuestion)
		a, err := ask(ctx, t.req, q)
		if err != nil {
			return nil, err
		}
		answer := strings.TrimSpace(a.Text)
		if a.Option >= 0 {
			if a.Option >= len(q.Options) {
				return nil, fmt.Errorf("invalid Claude Code answer")
			}
			answer = q.Options[a.Option]
		}
		answers[text] = answer
	}
	if len(answers) == 0 {
		return nil, fmt.Errorf("Claude Code asked a question without text")
	}
	t.setStep(claudeStepThinking)
	return answers, nil
}

// claudePermissionText is what a permission card says: the tool, Claude Code's own description of
// the action, and the command or file it is about.
func claudePermissionText(tool, description string, input map[string]any) string {
	text := "Claude Code asks to use " + tool
	if description != "" {
		text += ": " + description
	}
	detail := claudeString(input, "command")
	if detail == "" {
		detail = claudeString(input, "file_path")
	}
	if detail == "" && len(input) > 0 {
		raw, _ := json.Marshal(input)
		detail = string(raw)
	}
	if detail != "" {
		text += "\n" + clip(detail, claudeActivityMax)
	}
	return text
}

func claudeToolStep(name string) string {
	switch name {
	case "":
		return ""
	case "Bash", "BashOutput", "KillShell":
		return claudeStepCommand
	case "Edit", "MultiEdit", "Write", "NotebookEdit":
		return claudeStepEdit
	case "Read", "Glob", "Grep", "LS":
		return claudeStepRead
	case "WebFetch", "WebSearch":
		return claudeStepWeb
	case "TodoWrite":
		return claudeStepPlan
	case "Task", "Agent":
		return claudeStepSubagent
	case "AskUserQuestion":
		return claudeStepQuestion
	}
	if strings.HasPrefix(name, "mcp__") {
		return claudeStepTool
	}
	return "using " + name
}

func claudeString(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return strings.TrimSpace(s)
}

// claudeText is the text of a tool result's content: a string, or text blocks.
func claudeText(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, item := range v {
			b.WriteString(claudeText(item))
		}
		return b.String()
	case map[string]any:
		return claudeString(v, "text")
	}
	return ""
}

func clip(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

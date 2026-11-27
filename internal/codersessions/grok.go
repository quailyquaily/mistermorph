package codersessions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

// Grok Build (xAI's `grok`) as an ACP agent: `grok agent stdio`. What is written here about the
// CLI was seen on grok 1.0.92 (docs/feat/feat_20261126_coder_grok_build_acp.md has the findings):
//
//   - A cached sign-in (`grok login`) needs no `authenticate`; without one, `session/new` answers
//     error -32000. With XAI_API_KEY set, `authenticate` with `xai.api_key` signs in, though
//     `initialize` does not list that method.
//   - A session that is not always-approve asks with `session/request_permission`; the agent's own
//     question and its plan approval are the requests `_x.ai/ask_user_question` and
//     `_x.ai/exit_plan_mode`, also in an always-approve session.
//   - `session/cancel`, the end of its input and SIGTERM each stop the commands it started. A kill
//     does not: it runs them in sessions of their own. So the process is closed by ending its
//     input first (rpc.grace).
//   - The prompt's result carries the prompt's own usage, per model, in `_meta.usage.modelUsage`.

const (
	grokSignIn = "grok is not signed in: run grok login in a terminal, then try again"
	// grokNoTextReply is the answer of a task that ended without one.
	grokNoTextReply = "Grok Build finished this task without a text reply."
	// grokNewSessionNote tells that the earlier conversation could not be reopened.
	grokNewSessionNote = "Grok Build could not reopen the earlier session: this task starts a new one, without the earlier conversation."
	// grokExitGrace is how long a closed grok gets to stop what it started and exit (about 1.5 s
	// when seen) before it is killed.
	grokExitGrace = 3 * time.Second
	// grokCancelWait is how long a cancelled task waits for grok to answer its prompt.
	grokCancelWait = 2 * time.Second
	grokStepMax    = 200
)

// The requests grok puts to its host, besides ACP's session/request_permission. ACP names an
// extension method with a leading underscore; both forms are taken.
const (
	grokAskUserQuestion = "x.ai/ask_user_question"
	grokExitPlanMode    = "x.ai/exit_plan_mode"
)

// grokPending is a request of grok's that waits for the user's answer.
type grokPending struct {
	id     json.RawMessage
	method string
}

// cancelled is the answer that tells grok the user did not answer.
func (p grokPending) cancelled() any {
	if p.method == "session/request_permission" {
		return map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}
	}
	return map[string]any{"outcome": "cancelled"}
}

func (s *session) grok(ctx context.Context, req Request) (string, coderusage.Run, error) {
	run := coderusage.Run{Backend: coderusage.BackendGrok}
	var answer strings.Builder
	noted := 0     // how much of the answer was handed over as notes
	gap := false   // a tool call came after the text so far: what follows is a new paragraph
	lastStep := "" // the last progress line, not to repeat it
	var pending *grokPending
	handle := func(m message) error {
		if m.Method == "session/update" {
			var p struct {
				SessionID string `json:"sessionId"`
				Update    struct {
					Kind string `json:"sessionUpdate"`
					// A message chunk's content is one block; a tool call's is a list of them.
					Content json.RawMessage `json:"content"`
					Title   string          `json:"title"`
					Meta    struct {
						Tool struct {
							Name string `json:"name"`
						} `json:"x.ai/tool"`
					} `json:"_meta"`
				} `json:"update"`
			}
			// An update this host cannot read is not the task's failure.
			if err := json.Unmarshal(m.Params, &p); err != nil || p.SessionID != s.id {
				return nil
			}
			switch p.Update.Kind {
			case "agent_message_chunk":
				var block struct {
					Text string `json:"text"`
				}
				// A block that is not text (an image, a resource) has nothing to show here.
				_ = json.Unmarshal(p.Update.Content, &block)
				if block.Text == "" {
					break
				}
				if gap {
					answer.WriteString("\n\n")
					gap = false
				}
				answer.WriteString(block.Text)
			case "tool_call", "tool_call_update":
				// What grok wrote before it went on working is a note of its own, whole, not the
				// chunks it arrived in.
				note(req, strings.TrimSpace(answer.String()[noted:]))
				noted = answer.Len()
				gap = noted > 0
				// A call starts under its tool's bare name ("run_terminal_command") and is then
				// updated with a title that says what it does ("Execute `go test`"): that one is
				// the line. An update without a title says nothing new.
				step := grokStep(p.Update.Title)
				if step != "" && p.Update.Title != p.Update.Meta.Tool.Name && step != lastStep {
					lastStep = step
					progress(req, step)
				}
			case "plan":
				progress(req, "planning")
			}
			return nil
		}
		if len(m.ID) == 0 || m.Method == "" {
			// Every other notification (grok's `_x.ai/...` ones) is not for this host, and a
			// message without a method is a response, not a request: one that is not the
			// prompt's answers nothing this host is waiting for.
			return nil
		}
		method := strings.TrimPrefix(m.Method, "_")
		pending = &grokPending{id: m.ID, method: method}
		var (
			result any
			err    error
		)
		switch method {
		case "session/request_permission":
			result, err = s.grokPermission(ctx, req, m.Params)
		case grokAskUserQuestion:
			result, err = s.grokQuestion(ctx, req, m.Params)
		case grokExitPlanMode:
			result, err = s.grokPlan(ctx, req, m.Params)
		default:
			// Never a success for a request this host does not know (grok's fs, terminal and
			// other extensions): grok is told so, and the task says which one it was.
			pending = nil
			_ = s.rpc.replyError(m.ID, -32601, "Method not found")
			return fmt.Errorf("grok sent a request this host does not answer: %s", m.Method)
		}
		if err != nil {
			return err
		}
		pending = nil
		return s.rpc.reply(m.ID, result)
	}
	if s.rpc == nil {
		// Agent options go before the mode. --no-leader: the agent, and what it runs, belong to
		// this process and end with it. --no-auto-update: no update check in a task's way.
		args := []string{"--no-auto-update", "agent", "--no-leader"}
		if req.BypassApprovals {
			args = append(args, "--always-approve")
		}
		r, err := startRPC(req, append(args, "stdio")...)
		if err != nil {
			return "", run, err
		}
		r.grace = grokExitGrace
		s.rpc = r
		initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := s.grokOpen(initCtx, req); err != nil {
			if grokAuthError(err) {
				run.NotSignedIn = true
				return "", run, errors.New(grokSignIn)
			}
			return "", run, grokError(err)
		}
	}
	if req.Process != nil {
		req.Process(s.rpc.cmd.Process.Pid)
	}
	raw, err := s.rpc.call(ctx, "session/prompt", map[string]any{"sessionId": s.id, "prompt": []any{map[string]any{"type": "text", "text": req.Task}}}, handle)
	if err != nil {
		// A request left without an answer (the task was cancelled while the user was asked, or
		// the run cannot ask) is answered as cancelled, never left open and never granted.
		if pending != nil {
			_ = s.rpc.reply(pending.id, pending.cancelled())
		}
		if ctx.Err() != nil {
			// grok stops the commands it started when it is told; Sessions.Run closes it next.
			_ = s.rpc.notify("session/cancel", map[string]any{"sessionId": s.id})
			s.grokAwaitCancelled()
			return answer.String(), run, ctx.Err()
		}
		if grokAuthError(err) {
			run.NotSignedIn = true
			return answer.String(), run, errors.New(grokSignIn)
		}
		return answer.String(), run, grokError(err)
	}
	var result struct {
		Stop string `json:"stopReason"`
		Meta struct {
			ModelID  string          `json:"modelId"`
			Usage    json.RawMessage `json:"usage"`
			Category string          `json:"cancellationCategory"`
		} `json:"_meta"`
	}
	if err = json.Unmarshal(raw, &result); err != nil {
		return answer.String(), run, fmt.Errorf("grok answered the prompt with a result this host cannot read: %w", err)
	}
	if models := grokUsage(result.Meta.Usage, firstNonEmptyString(result.Meta.ModelID, s.model)); len(models) > 0 {
		run.Turns = 1
		run.Models = models
	}
	switch {
	case result.Stop == "end_turn":
	case result.Stop == "cancelled" && result.Meta.Category == "PermissionRejected":
		// grok ends the turn when an approval is rejected.
		return answer.String(), run, fmt.Errorf("grok ended the task: the approval it asked for was rejected")
	case result.Stop == "":
		return answer.String(), run, fmt.Errorf("grok prompt ended without a stop reason")
	default:
		return answer.String(), run, fmt.Errorf("grok prompt ended: %s", result.Stop)
	}
	if strings.TrimSpace(answer.String()) == "" {
		return grokNoTextReply, run, nil
	}
	return answer.String(), run, nil
}

// grokOpen does the handshake and opens the session: the one the scope had, reopened by what the
// agent says it can (session/resume, else session/load), else a new one.
func (s *session) grokOpen(ctx context.Context, req Request) error {
	raw, err := s.rpc.call(ctx, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]any{"name": "mistermorph", "version": "1"}}, nil)
	if err != nil {
		return err
	}
	var capabilities struct {
		AgentCapabilities struct {
			SessionCapabilities map[string]json.RawMessage `json:"sessionCapabilities"`
			LoadSession         bool                       `json:"loadSession"`
		} `json:"agentCapabilities"`
	}
	_ = json.Unmarshal(raw, &capabilities)
	open := func(method string, params map[string]any) (json.RawMessage, error) {
		// No handler: what session/load replays of the earlier conversation is not this task's
		// answer, notes or progress.
		raw, err := s.rpc.call(ctx, method, params, nil)
		if err == nil || !grokAuthError(err) || grokEnv(req, "XAI_API_KEY") == "" {
			return raw, err
		}
		// No cached sign-in, and a key in the coder's environment: the CLI signs in with it,
		// without a browser. Nothing else is tried.
		if _, err := s.rpc.call(ctx, "authenticate", map[string]any{"methodId": "xai.api_key", "_meta": map[string]any{"headless": true}}, nil); err != nil {
			return nil, err
		}
		return s.rpc.call(ctx, method, params, nil)
	}
	if s.id != "" {
		method := ""
		if _, ok := capabilities.AgentCapabilities.SessionCapabilities["resume"]; ok {
			method = "session/resume"
		} else if capabilities.AgentCapabilities.LoadSession {
			method = "session/load"
		}
		if method != "" {
			raw, err = open(method, map[string]any{"sessionId": s.id, "cwd": req.CWD, "mcpServers": []any{}})
			if err == nil {
				s.grokModel(raw)
				return nil
			}
			if grokAuthError(err) || ctx.Err() != nil || s.rpc.ended() {
				return err
			}
		}
		// The earlier session is gone, or cannot be reopened: the task is not failed for it.
		s.id = ""
		note(req, grokNewSessionNote)
	}
	raw, err = open("session/new", map[string]any{"cwd": req.CWD, "mcpServers": []any{}})
	if err != nil {
		return err
	}
	var result struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(raw, &result)
	if result.SessionID == "" {
		return fmt.Errorf("grok returned no session id")
	}
	s.id = result.SessionID
	s.grokModel(raw)
	return nil
}

// grokModel keeps the model a session's result names, for a prompt whose result names none.
func (s *session) grokModel(raw json.RawMessage) {
	var result struct {
		Models struct {
			Current string `json:"currentModelId"`
		} `json:"models"`
	}
	if json.Unmarshal(raw, &result) == nil && result.Models.Current != "" {
		s.model = result.Models.Current
	}
}

// grokAwaitCancelled reads what grok still sends after session/cancel, until it answers the
// prompt or grokCancelWait passes. A request it still makes is answered as cancelled.
func (s *session) grokAwaitCancelled() {
	ctx, cancel := context.WithTimeout(context.Background(), grokCancelWait)
	defer cancel()
	id := fmt.Sprint(s.rpc.next)
	for {
		m, err := s.rpc.read(ctx)
		if err != nil {
			return
		}
		if m.Method == "" {
			if string(m.ID) == id {
				return
			}
			continue
		}
		if len(m.ID) > 0 {
			_ = s.rpc.reply(m.ID, grokPending{method: strings.TrimPrefix(m.Method, "_")}.cancelled())
		}
	}
}

// grokPermission answers session/request_permission: the user chooses among the agent's options.
// In a session started always-approve the request is unexpected: it is allowed once, with a note,
// never for good.
func (s *session) grokPermission(ctx context.Context, req Request, params json.RawMessage) (any, error) {
	var p struct {
		ToolCall struct {
			Title string `json:"title"`
		} `json:"toolCall"`
		Options []struct {
			ID   string `json:"optionId"`
			Name string `json:"name"`
			Kind string `json:"kind"`
		} `json:"options"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("grok asked for an approval this host cannot read: %w", err)
	}
	title := firstNonEmptyString(strings.TrimSpace(p.ToolCall.Title), "an action")
	choice := -1
	if req.BypassApprovals {
		for i, o := range p.Options {
			if o.Kind == "allow_once" {
				choice = i
				break
			}
		}
		if choice < 0 {
			return nil, fmt.Errorf("grok asked for an approval it should not need, and offers no way to allow it once: %s", title)
		}
		note(req, "Grok Build asked for an approval though approvals are off for it; allowed once: "+title)
	} else {
		q := Question{Text: title, ChoicesOnly: true}
		for _, o := range p.Options {
			q.Options = append(q.Options, o.Name)
		}
		a, err := ask(ctx, req, q)
		if err != nil {
			return nil, err
		}
		choice = a.Option
	}
	if choice < 0 || choice >= len(p.Options) {
		return nil, fmt.Errorf("grok returned an invalid permission choice")
	}
	return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": p.Options[choice].ID}}, nil
}

// grokQuestion puts the questions of grok's ask_user_question tool to the user, one card each. The
// answers go back by question text: the chosen option's label, or "Other" with the typed text as
// the question's note.
func (s *session) grokQuestion(ctx context.Context, req Request, params json.RawMessage) (any, error) {
	var p struct {
		Questions []struct {
			Question string `json:"question"`
			Options  []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("grok asked a question this host cannot read: %w", err)
	}
	answers := map[string][]string{}
	annotations := map[string]any{}
	for _, item := range p.Questions {
		text := strings.TrimSpace(item.Question)
		if text == "" {
			continue
		}
		q := Question{Text: text}
		for _, o := range item.Options {
			if o.Label == "" {
				continue
			}
			q.Options = append(q.Options, o.Label)
			if o.Description != "" {
				q.Text += "\n- " + o.Label + ": " + o.Description
			}
		}
		a, err := ask(ctx, req, q)
		if err != nil {
			return nil, err
		}
		if a.Option >= 0 {
			if a.Option >= len(q.Options) {
				return nil, fmt.Errorf("invalid Grok Build answer")
			}
			answers[item.Question] = []string{q.Options[a.Option]}
			continue
		}
		answers[item.Question] = []string{"Other"}
		annotations[item.Question] = map[string]any{"notes": strings.TrimSpace(a.Text)}
	}
	if len(answers) == 0 {
		return nil, fmt.Errorf("grok asked a question without text")
	}
	result := map[string]any{"outcome": "accepted", "answers": answers}
	if len(annotations) > 0 {
		result["annotations"] = annotations
	}
	return result, nil
}

// grokPlan answers the plan grok puts up for approval when it leaves plan mode. A Console
// conversation that is asked for approvals decides: approve, reject, or reject with what to
// change. Everywhere else the plan is approved and written down as a note.
func (s *session) grokPlan(ctx context.Context, req Request, params json.RawMessage) (any, error) {
	var p struct {
		Plan string `json:"planContent"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("grok put up a plan this host cannot read: %w", err)
	}
	plan := strings.TrimSpace(p.Plan)
	if req.BypassApprovals {
		note(req, strings.TrimSpace("Grok Build's plan, approved without asking:\n\n"+plan))
		return map[string]any{"outcome": "approved"}, nil
	}
	a, err := ask(ctx, req, Question{Text: strings.TrimSpace("Grok Build's plan:\n\n" + plan), Options: []string{"Approve", "Reject"}})
	if err != nil {
		return nil, err
	}
	switch {
	case a.Option == 0:
		return map[string]any{"outcome": "approved"}, nil
	case a.Option < 0 && strings.TrimSpace(a.Text) != "":
		return map[string]any{"outcome": "cancelled", "feedback": strings.TrimSpace(a.Text)}, nil
	}
	return map[string]any{"outcome": "cancelled"}, nil
}

// grokUsage reads the prompt's usage per model from the result's `_meta.usage`. Nothing about
// its form is promised: what cannot be read records no usage and never fails the task.
// inputTokens counts cached reads too, as ModelUsage does.
func grokUsage(raw json.RawMessage, model string) []coderusage.ModelUsage {
	type counts struct {
		Input     int64 `json:"inputTokens"`
		Output    int64 `json:"outputTokens"`
		Read      int64 `json:"cachedReadTokens"`
		Write     int64 `json:"cacheCreationTokens"`
		Reasoning int64 `json:"reasoningTokens"`
	}
	var usage struct {
		counts
		Models map[string]json.RawMessage `json:"modelUsage"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &usage) != nil {
		return nil
	}
	row := func(model string, c counts) (coderusage.ModelUsage, bool) {
		if c.Input < 0 || c.Output < 0 || c.Read < 0 || c.Write < 0 || c.Reasoning < 0 || c.Input+c.Output == 0 {
			return coderusage.ModelUsage{}, false
		}
		return coderusage.ModelUsage{Model: model, InputTokens: c.Input, CachedInputTokens: c.Read, CacheCreationInputTokens: c.Write, OutputTokens: c.Output, ReasoningTokens: c.Reasoning}, true
	}
	var out []coderusage.ModelUsage
	for name, item := range usage.Models {
		var c counts
		if strings.TrimSpace(name) == "" || json.Unmarshal(item, &c) != nil {
			continue
		}
		if m, ok := row(name, c); ok {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		if m, ok := row(firstNonEmptyString(model, coderusage.BackendGrok), usage.counts); ok {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Model < out[j].Model })
	return out
}

// grokAuthError tells a missing sign-in: ACP's error -32000, or the service refusing the
// credentials (HTTP 401).
func grokAuthError(err error) bool {
	var call *callError
	if !errors.As(err, &call) {
		return false
	}
	if call.Code == -32000 || strings.Contains(strings.ToLower(call.Message), "authentication required") {
		return true
	}
	var data struct {
		Status int `json:"http_status"`
	}
	return json.Unmarshal(call.Data, &data) == nil && data.Status == 401
}

// grokError names what grok said went wrong: its error's data carries the message ("API error
// (status 429 ...)") where the error itself only says "Internal error".
func grokError(err error) error {
	var call *callError
	if !errors.As(err, &call) {
		return err
	}
	var data struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(call.Data, &data) == nil && strings.TrimSpace(data.Message) != "" {
		return fmt.Errorf("grok %s failed: %s", call.method, strings.TrimSpace(data.Message))
	}
	return fmt.Errorf("grok %s failed: %s", call.method, call.Message)
}

// grokStep is a tool call's title as a progress line: one line, not longer than grokStepMax.
func grokStep(title string) string {
	step := strings.Join(strings.Fields(title), " ")
	if r := []rune(step); len(r) > grokStepMax {
		step = string(r[:grokStepMax-1]) + "…"
	}
	return step
}

// grokEnv is a variable of the environment grok is started in.
func grokEnv(req Request, key string) string {
	value := ""
	for _, item := range envOrProcess(req.Env) {
		if name, v, ok := strings.Cut(item, "="); ok && name == key {
			value = v
		}
	}
	return strings.TrimSpace(value)
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

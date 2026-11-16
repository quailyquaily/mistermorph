package codersessions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

const agySignIn = "agy is not signed in: run agy once in a terminal and sign in with a Google account, then try again"

func (s *session) agy(ctx context.Context, req Request) (string, coderusage.Run, error) {
	run := coderusage.Run{Backend: "agy"}
	var answer strings.Builder
	noted := 0 // how much of the answer was handed over as notes
	lastStep := ""
	handle := func(m message) error {
		if m.Method == "session/update" {
			var p struct {
				SessionID string `json:"sessionId"`
				Update    struct {
					Kind string `json:"sessionUpdate"`
					// A message chunk's content is one block; a tool call's is a list of them.
					Content        json.RawMessage `json:"content"`
					Title          string          `json:"title"`
					KindTool       string          `json:"kind"`
					CurrentModelID string          `json:"currentModelId"`
				} `json:"update"`
			}
			if err := json.Unmarshal(m.Params, &p); err != nil {
				return err
			}
			if p.SessionID != s.id {
				return nil
			}
			switch p.Update.Kind {
			case "agent_message_chunk":
				var block struct {
					Text string `json:"text"`
				}
				// A block that is not text (an image, a resource) has nothing to show here.
				_ = json.Unmarshal(p.Update.Content, &block)
				answer.WriteString(block.Text)
			case "tool_call", "tool_call_update":
				// What agy wrote before it went on working is a note of its own, whole, not
				// the chunks it arrived in.
				note(req, strings.TrimSpace(answer.String()[noted:]))
				noted = answer.Len()
				// An update carries only what changed: without a title it says nothing new,
				// and with the same one it would repeat the line.
				step := strings.TrimPrefix(p.Update.KindTool+": "+p.Update.Title, ": ")
				if p.Update.Title != "" && step != lastStep {
					lastStep = step
					progress(req, step)
				}
			case "plan":
				progress(req, "planning")
			case "current_model_update":
				s.model = p.Update.CurrentModelID
			}
			return nil
		}
		if len(m.ID) == 0 {
			return nil
		}
		if m.Method != "session/request_permission" {
			return fmt.Errorf("agy needs a user answer (%s): %s", m.Method, m.Params)
		}
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
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return err
		}
		choice := -1
		if req.BypassApprovals {
			for i, o := range p.Options {
				if o.Kind == "allow_once" {
					choice = i
					break
				}
			}
		} else {
			q := Question{Text: p.ToolCall.Title, ChoicesOnly: true}
			for _, o := range p.Options {
				q.Options = append(q.Options, o.Name)
			}
			a, err := ask(ctx, req, q)
			if err != nil {
				return err
			}
			choice = a.Option
		}
		if choice < 0 || choice >= len(p.Options) {
			return fmt.Errorf("agy returned an invalid permission choice")
		}
		return s.rpc.reply(m.ID, map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": p.Options[choice].ID}})
	}
	if s.rpc == nil {
		args := []string{"acp"}
		if req.BypassApprovals {
			args = append(args, "--dangerously-skip-permissions")
		}
		r, err := startRPC(req, args...)
		if err != nil {
			return "", run, err
		}
		s.rpc = r
		initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		raw, err := r.call(initCtx, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]any{"name": "mistermorph", "version": "1"}}, nil)
		if err != nil {
			return "", run, err
		}
		var capabilities struct {
			AgentCapabilities struct {
				SessionCapabilities map[string]json.RawMessage `json:"sessionCapabilities"`
				LoadSession         bool                       `json:"loadSession"`
			} `json:"agentCapabilities"`
		}
		_ = json.Unmarshal(raw, &capabilities)
		method := "session/new"
		params := map[string]any{"cwd": req.CWD, "mcpServers": []any{}}
		if s.id != "" {
			params["sessionId"] = s.id
			method = "session/load"
			if _, ok := capabilities.AgentCapabilities.SessionCapabilities["resume"]; ok {
				method = "session/resume"
			} else if !capabilities.AgentCapabilities.LoadSession {
				return "", run, fmt.Errorf("agy cannot reopen this session")
			}
		}
		raw, err = r.call(initCtx, method, params, handle)
		if err != nil {
			if coderusage.IsAgyAuthError(err.Error()) || strings.Contains(strings.ToLower(err.Error()), "auth") {
				run.NotSignedIn = true
				return "", run, fmt.Errorf("%s", agySignIn)
			}
			return "", run, err
		}
		var result struct {
			SessionID string `json:"sessionId"`
			Models    struct {
				Current string `json:"currentModelId"`
			} `json:"models"`
		}
		if err = json.Unmarshal(raw, &result); err != nil {
			return "", run, err
		}
		if result.SessionID != "" {
			s.id = result.SessionID
		}
		s.model = result.Models.Current
		if s.id == "" {
			return "", run, fmt.Errorf("agy returned no session id")
		}
	}
	if req.Process != nil {
		req.Process(s.rpc.cmd.Process.Pid)
	}
	raw, err := s.rpc.call(ctx, "session/prompt", map[string]any{"sessionId": s.id, "prompt": []any{map[string]any{"type": "text", "text": req.Task}}}, handle)
	if err != nil {
		if ctx.Err() != nil {
			_ = s.rpc.notify("session/cancel", map[string]any{"sessionId": s.id})
		}
		return answer.String(), run, err
	}
	var result struct {
		Stop  string `json:"stopReason"`
		Usage struct {
			Input   int64 `json:"inputTokens"`
			Output  int64 `json:"outputTokens"`
			Read    int64 `json:"cachedReadTokens"`
			Write   int64 `json:"cachedWriteTokens"`
			Thought int64 `json:"thoughtTokens"`
		} `json:"usage"`
	}
	if err = json.Unmarshal(raw, &result); err != nil {
		return answer.String(), run, err
	}
	u := result.Usage
	// The model agy says it runs, so the catalog can price it; a model the catalog has no price
	// for keeps its tokens and no cost. ACP reports the prompt's total, not its requests: the
	// prompt is priced as one request.
	model := s.model
	if model == "" {
		model = "agy"
	}
	run.Turns = 1
	run.Models = []coderusage.ModelUsage{{Model: model, InputTokens: u.Input, CachedInputTokens: u.Read, CacheCreationInputTokens: u.Write, OutputTokens: u.Output, ReasoningTokens: u.Thought}}
	if result.Stop != "end_turn" {
		return answer.String(), run, fmt.Errorf("agy prompt ended: %s", result.Stop)
	}
	return answer.String(), run, nil
}

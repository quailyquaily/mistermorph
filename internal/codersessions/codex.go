package codersessions

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

func (s *session) codex(ctx context.Context, req Request) (output string, run coderusage.Run, quota *coderusage.Quota, err error) {
	run.Backend = "codex"
	getenv := func(key string) string {
		if req.Env == nil {
			return os.Getenv(key)
		}
		v := ""
		for _, entry := range req.Env {
			if k, x, ok := strings.Cut(entry, "="); ok && k == key {
				v = x
			}
		}
		return v
	}
	home := getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	turnID := ""
	done := false
	var failure error
	var deltas strings.Builder
	tracking := false
	fallback := coderusage.ModelUsage{Model: s.model}
	handle := func(m message) error {
		if len(m.ID) > 0 && m.Method != "" {
			return s.codexQuestion(ctx, req, m)
		}
		var p struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			Delta    string `json:"delta"`
			Turn     struct {
				ID     string `json:"id"`
				Status string `json:"status"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"turn"`
			Item struct {
				Type  string `json:"type"`
				Text  string `json:"text"`
				Phase string `json:"phase"`
			} `json:"item"`
			TokenUsage struct {
				Total struct {
					Total int64 `json:"totalTokens"`
				} `json:"total"`
				Last struct {
					Input     int64 `json:"inputTokens"`
					Cached    int64 `json:"cachedInputTokens"`
					Write     int64 `json:"cacheWriteInputTokens"`
					Output    int64 `json:"outputTokens"`
					Reasoning int64 `json:"reasoningOutputTokens"`
				} `json:"last"`
			} `json:"tokenUsage"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return err
		}
		if p.ThreadID != "" && p.ThreadID != s.id {
			return nil
		}
		if turnID != "" && p.TurnID != "" && p.TurnID != turnID {
			return nil
		}
		switch m.Method {
		case "item/agentMessage/delta":
			deltas.WriteString(p.Delta)
		case "item/started", "item/completed":
			progress(req, codexItemStep(p.Item.Type))
			if m.Method == "item/completed" && p.Item.Type == "agentMessage" {
				// A message before the last one is what Codex said while working: a note of
				// its own, whole, not the chunks it arrived in.
				note(req, output)
				output = p.Item.Text
			}
		case "turn/plan/updated":
			progress(req, "planning")
		case "item/commandExecution/outputDelta":
			note(req, p.Delta)
		case "thread/tokenUsage/updated":
			if !tracking {
				s.tokenTotal = p.TokenUsage.Total.Total
				return nil
			}
			if p.TokenUsage.Total.Total <= s.tokenTotal {
				return nil
			}
			s.tokenTotal = p.TokenUsage.Total.Total
			u := p.TokenUsage.Last
			fallback.InputTokens += u.Input
			fallback.CachedInputTokens += u.Cached
			fallback.CacheCreationInputTokens += u.Write
			fallback.OutputTokens += u.Output
			fallback.ReasoningTokens += u.Reasoning
			fallback.Requests = append(fallback.Requests, coderusage.RequestUsage{InputTokens: u.Input, CachedInputTokens: u.Cached, CacheCreationInputTokens: u.Write, OutputTokens: u.Output, Count: 1})
		case "turn/completed":
			if turnID != "" && p.Turn.ID != turnID {
				return nil
			}
			done = true
			run.Turns = 1
			if p.Turn.Status != "completed" {
				detail := p.Turn.Status
				if p.Turn.Error != nil {
					detail += "; " + p.Turn.Error.Message
				}
				failure = fmt.Errorf("codex turn %s", detail)
			}
		}
		return nil
	}
	if s.rpc == nil {
		s.rpc, err = startRPC(req, "app-server")
		if err != nil {
			return
		}
		initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		_, err = s.rpc.call(initCtx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "mistermorph", "version": "1"}, "capabilities": map[string]any{"experimentalApi": true}}, nil)
		if err != nil {
			return
		}
		if err = s.rpc.notify("initialized", map[string]any{}); err != nil {
			return
		}
		policy, sandbox := "on-request", "workspace-write"
		if req.BypassApprovals {
			policy, sandbox = "never", "danger-full-access"
		}
		params := map[string]any{"cwd": req.CWD, "approvalPolicy": policy, "sandbox": sandbox}
		method := "thread/start"
		resumed := s.id != ""
		if resumed {
			method = "thread/resume"
			params["threadId"] = s.id
		}
		var raw json.RawMessage
		raw, err = s.rpc.call(initCtx, method, params, handle)
		if err != nil {
			return
		}
		var response struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
			Model string `json:"model"`
		}
		if err = json.Unmarshal(raw, &response); err != nil {
			return
		}
		s.id = response.Thread.ID
		s.model = response.Model
		if s.id == "" {
			err = fmt.Errorf("codex returned no thread id")
			return
		}
		if s.usage == nil {
			s.usage = NewCodexUsageReader(getenv, home, req.CWD, s.id, resumed)
		}
	}
	fallback.Model = s.model
	if fallback.Model == "" {
		fallback.Model = "codex"
	}
	if req.Process != nil {
		req.Process(s.rpc.cmd.Process.Pid)
	}
	defer func() {
		if ctx.Err() != nil && turnID != "" {
			stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			_, _ = s.rpc.call(stopCtx, "turn/interrupt", map[string]any{"threadId": s.id, "turnId": turnID}, handle)
			cancel()
		}
		if output == "" {
			output = deltas.String()
		}
		if s.usage != nil && !s.protocolUsage {
			u := s.usage.Take(getenv, home, req.CWD, s.id)
			run.Models = ModelsFromUsage(u)
		}
		if len(run.Models) == 0 && (fallback.InputTokens > 0 || fallback.OutputTokens > 0) {
			s.protocolUsage = true
			run.Models = []coderusage.ModelUsage{fallback}
		}
		tracking = false
		if ctx.Err() == nil && err == nil {
			quotaCtx, cancel := context.WithTimeout(ctx, coderusage.CodexReadTimeout)
			defer cancel()
			raw, e := s.rpc.call(quotaCtx, "account/rateLimits/read", nil, handle)
			if e == nil {
				if q, e := coderusage.ParseCodexRateLimits(raw, time.Now()); e == nil {
					quota = &q
				}
			}
		}
	}()
	tracking = true
	raw, e := s.rpc.call(ctx, "turn/start", map[string]any{"threadId": s.id, "input": []any{map[string]any{"type": "text", "text": req.Task}}}, handle)
	if e != nil {
		err = e
		return
	}
	var response struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err = json.Unmarshal(raw, &response); err != nil {
		return
	}
	turnID = response.Turn.ID
	if turnID == "" {
		err = fmt.Errorf("codex returned no turn id")
		return
	}
	for !done {
		m, e := s.rpc.read(ctx)
		if e != nil {
			err = e
			return
		}
		if err = handle(m); err != nil {
			return
		}
	}
	err = failure
	return
}
func (s *session) codexQuestion(ctx context.Context, req Request, m message) error {
	if m.Method == "item/tool/requestUserInput" {
		var p struct {
			Questions []struct {
				ID       string `json:"id"`
				Question string `json:"question"`
				Options  []struct {
					Label string `json:"label"`
				} `json:"options"`
			} `json:"questions"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return err
		}
		answers := map[string]any{}
		for _, q := range p.Questions {
			question := Question{Text: q.Question}
			for _, o := range q.Options {
				question.Options = append(question.Options, o.Label)
			}
			a, err := ask(ctx, req, question)
			if err != nil {
				return err
			}
			text := a.Text
			if a.Option >= 0 {
				if a.Option >= len(question.Options) {
					return fmt.Errorf("invalid Codex answer")
				}
				text = question.Options[a.Option]
			}
			answers[q.ID] = map[string]any{"answers": []string{text}}
		}
		return s.rpc.reply(m.ID, map[string]any{"answers": answers})
	}
	switch m.Method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval":
	default:
		return fmt.Errorf("unsupported Codex request %s: %s", m.Method, m.Params)
	}
	allow := req.BypassApprovals
	if !allow {
		a, err := ask(ctx, req, Question{Text: m.Method + "\n" + string(m.Params), Options: []string{"Allow once", "Deny"}, ChoicesOnly: true})
		if err != nil {
			return err
		}
		if a.Option != 0 && a.Option != 1 {
			return fmt.Errorf("invalid Codex approval choice")
		}
		allow = a.Option == 0
	}
	if m.Method == "item/permissions/requestApproval" {
		permissions := json.RawMessage(`{}`)
		if allow {
			var p struct {
				Permissions json.RawMessage `json:"permissions"`
			}
			if err := json.Unmarshal(m.Params, &p); err != nil {
				return err
			}
			if len(p.Permissions) > 0 {
				permissions = p.Permissions
			}
		}
		return s.rpc.reply(m.ID, map[string]any{"permissions": permissions, "scope": "turn"})
	}
	decision := "decline"
	if allow {
		decision = "accept"
	}
	return s.rpc.reply(m.ID, map[string]any{"decision": decision})
}
func codexItemStep(kind string) string {
	switch kind {
	case "commandExecution":
		return "running a command"
	case "fileChange":
		return "editing files"
	case "mcpToolCall", "dynamicToolCall":
		return "using a tool"
	case "webSearch":
		return "searching the web"
	case "plan":
		return "planning"
	case "reasoning":
		return "thinking"
	case "agentMessage":
		return "writing a reply"
	case "collabAgentToolCall":
		return "working with a sub-agent"
	}
	return "working"
}

// ModelsFromUsage preserves individual requests for catalog pricing.
func ModelsFromUsage(usage Usage) []coderusage.ModelUsage {
	var models []coderusage.ModelUsage
	for _, m := range usage.Models {
		model := coderusage.ModelUsage{Model: m.Model, InputTokens: m.InputTokens, CachedInputTokens: m.CachedInputTokens, CacheCreationInputTokens: m.CacheCreationInputTokens, OutputTokens: m.OutputTokens, ReasoningTokens: m.ReasoningTokens, CacheDetails: m.CacheCreation}
		for _, r := range m.Responses {
			model.Requests = append(model.Requests, coderusage.RequestUsage{InputTokens: r.InputTokens, CachedInputTokens: r.CachedInputTokens, CacheCreationInputTokens: r.CacheCreationInputTokens, OutputTokens: r.OutputTokens, CacheDetails: r.CacheCreation, Count: r.Count})
		}
		models = append(models, model)
	}
	return models
}

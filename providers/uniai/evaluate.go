package uniai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/uniai/chat"
	"github.com/quailyquaily/uniai/evaluate"
)

func (c *Client) Evaluate(ctx context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	if c == nil || c.client == nil {
		return nil, llm.ErrEvaluateUnsupported
	}
	if c.requestTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.requestTimeout)
		defer cancel()
	}
	questions := make(map[string]evaluate.Question, len(req.Questions))
	for name, q := range req.Questions {
		questions[name] = evaluate.Question{Kind: evaluate.Kind(q.Kind), Instructions: q.Instructions, Options: q.Options, Levels: q.Levels}
	}
	r := evaluate.Request{Provider: c.provider, Model: firstNonEmpty(strings.TrimSpace(req.Model), c.model), EmulationMode: evaluate.EmulationFallback, State: req.State, Questions: questions}
	if c.provider != "typesafe" {
		r.InferenceProvider = c.inferenceProvider
		if c.reasoningEffort != "" {
			effort := chat.ReasoningEffort(c.reasoningEffort)
			r.EmulationOptions = &evaluate.EmulationOptions{ReasoningEffort: &effort}
		}
	}
	if req.DebugFn != nil {
		if b, err := json.Marshal(r); err == nil {
			req.DebugFn("evaluate_request", string(b))
		}
	}
	started := time.Now()
	res, err := c.client.Evaluate(ctx, r)
	switch {
	case errors.Is(err, evaluate.ErrUnsupported):
		err = errors.Join(llm.ErrEvaluateUnsupported, err)
	case errors.Is(err, evaluate.ErrInvalidRequest):
		err = errors.Join(llm.ErrEvaluateInvalidRequest, err)
	case errors.Is(err, evaluate.ErrInvalidResponse):
		err = errors.Join(llm.ErrEvaluateInvalidResponse, err)
	}
	if res == nil {
		return nil, err
	}
	out := &llm.EvaluateResult{Provider: res.Provider, Model: res.Model, Emulated: res.Emulated, Duration: time.Since(started)}
	if err == nil {
		out.Answers = make(map[string]llm.Answer, len(res.Answers))
		for name, a := range res.Answers {
			out.Answers[name] = llm.Answer{Kind: llm.QuestionKind(a.Kind), BooleanValue: a.BooleanValue, ProbabilityTrue: a.ProbabilityTrue, Selected: a.Selected, ScoreValue: a.ScoreValue}
		}
	}
	if res.Usage != nil {
		u := res.Usage
		usage := chat.Usage{Cost: u.Cost}
		if u.InputTokens != nil {
			usage.InputTokens = *u.InputTokens
		}
		if u.OutputTokens != nil {
			usage.OutputTokens = *u.OutputTokens
		}
		if u.TotalTokens != nil {
			usage.TotalTokens = *u.TotalTokens
		}
		// Emulation preserves the original Chat usage, including cache counters.
		if res.Emulated {
			var metadata struct {
				Usage chat.Usage `json:"chat_usage"`
			}
			if json.Unmarshal(res.ProviderMetadata[res.Provider], &metadata) == nil {
				usage.Cache = metadata.Usage.Cache
			}
		}
		out.Usage = &llm.EvaluateUsage{InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, TotalTokens: u.TotalTokens, Details: toLLMUsage(usage)}
	}
	if req.DebugFn != nil {
		if b, marshalErr := json.Marshal(out); marshalErr == nil {
			req.DebugFn("evaluate_response", string(b))
		}
	}
	return out, err
}

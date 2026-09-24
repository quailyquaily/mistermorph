package llmutil

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

func evaluateFallbackReason(err error) (string, bool) {
	if errors.Is(err, llm.ErrEvaluateUnsupported) || errors.Is(err, llm.ErrEvaluateInvalidRequest) || errors.Is(err, llm.ErrEvaluateInvalidResponse) {
		return "", false
	}
	return fallbackEligibleReason(err)
}

func (c *fallbackClient) Evaluate(ctx context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	if c == nil || c.primary == nil {
		return nil, llm.ErrEvaluateUnsupported
	}
	candidates := append([]FallbackCandidate{{Client: c.primary, Profile: c.primaryProfile, Model: c.primaryModel}}, c.fallbacks...)
	var result *llm.EvaluateResult
	var err error
	for idx, candidate := range candidates {
		r := req
		if idx > 0 || r.Model == "" {
			r.Model = candidate.Model
		}
		result, err = c.evaluateWithRetry(ctx, candidate, r)
		if err == nil || ctx.Err() != nil {
			return result, err
		}
		reason, eligible := evaluateFallbackReason(err)
		if !eligible {
			return result, err
		}
		if idx+1 < len(candidates) {
			c.logFallback("llm_evaluate_profile_fallback", idx+1, candidates[idx+1].Profile, candidates[idx+1].Model, reason, err)
		}
	}
	return result, err
}

func (c *fallbackClient) evaluateWithRetry(ctx context.Context, candidate FallbackCandidate, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	for attempt := 0; ; attempt++ {
		res, err := llm.Evaluate(ctx, candidate.Client, req)
		if err == nil || ctx.Err() != nil {
			return res, err
		}
		reason, eligible := evaluateFallbackReason(err)
		if !eligible || attempt >= llmRequestRetries {
			return res, err
		}
		switch reason {
		case "status_401", "status_403", "status_404", "status_415", "status_422", "status_429":
			return res, err
		}
		limit := time.Second << attempt
		delay := limit/2 + time.Duration(rand.Int64N(int64(limit/2)))
		if c.logger != nil {
			c.logger.Warn("llm_evaluate_retry", "profile", candidate.Profile, "model", req.Model, "scene", req.Scene, "retry", attempt+1, "delay", delay, "error", err.Error())
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return res, ctx.Err()
		case <-timer.C:
		}
	}
}

func (c *weightedRouteClient) Evaluate(ctx context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	if c == nil || len(c.candidates) == 0 {
		return nil, llm.ErrEvaluateUnsupported
	}
	primaryIdx := c.pickPrimaryIndex(ctx, llm.Request{Scene: req.Scene})
	req.Model = c.candidates[primaryIdx].Model
	return llm.Evaluate(ctx, c.fallbackForPrimary(primaryIdx), req)
}

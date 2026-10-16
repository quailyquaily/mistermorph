package integration

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

const defaultIntegrationEvaluateScene = "integration.evaluate"

type EvaluateOptions struct {
	// Profile asks this profile instead of the route. Empty follows llm.routes.decision, then the
	// default profile.
	Profile string
}

// Evaluate asks closed questions (boolean, choice, score) on llm.routes.decision, the way the
// group reply check does, with the route's candidates and fallback_profiles. It returns
// llm.ErrEvaluateUnsupported when the chosen profile cannot evaluate, so the caller can fall
// back to RunTaskWithOptions. An empty req.Model uses the route's model, and an empty req.Scene
// is "integration.evaluate".
func (rt *Runtime) Evaluate(ctx context.Context, req llm.EvaluateRequest, opts EvaluateOptions) (*llm.EvaluateResult, error) {
	if rt == nil {
		return nil, fmt.Errorf("runtime is nil")
	}
	if err := rt.Err(); err != nil {
		return nil, err
	}
	snap := rt.snapshot()
	if snap.InitErr != nil {
		return nil, snap.InitErr
	}
	ctx = ensureIntegrationRunContext(ctx)

	var (
		route llmutil.ResolvedRoute
		err   error
	)
	if profile := strings.TrimSpace(opts.Profile); profile != "" {
		route, err = llmutil.ResolveRouteWithProfileOverride(snap.LLMValues, llmutil.RoutePurposeDecision, profile)
	} else {
		route, err = llmutil.ResolveRoute(snap.LLMValues, llmutil.RoutePurposeDecision)
	}
	if err != nil {
		return nil, err
	}
	client, err := rt.buildLLMClient(route, snap.Logger, integrationUsageClientWrap(snap.Paths, snap.Logger))
	if err != nil {
		return nil, err
	}
	if closer, ok := client.(io.Closer); ok && closer != nil {
		defer func() { _ = closer.Close() }()
	}
	if strings.TrimSpace(req.Scene) == "" {
		req.Scene = defaultIntegrationEvaluateScene
	}
	return llm.Evaluate(ctx, client, req)
}

package llmutil

import (
	"net/url"
	"strings"

	"github.com/quailyquaily/mistermorph/llm"
)

// OverviewLLM is the main loop's model as GET /overview reports it: what the running agent
// resolved, so the Console's Status page shows what is in use rather than what is saved. It never
// carries a secret: no API key, no headers, and of the endpoint only its host (a path or query can
// hold a key or an account).
//
// model is the model the runtime reports as its own (a channel runtime's bootstrap model); when
// empty, the route's.
func OverviewLLM(route ResolvedRoute, model string) map[string]any {
	model = strings.TrimSpace(model)
	if model == "" {
		model = strings.TrimSpace(route.ClientConfig.Model)
	}
	out := map[string]any{
		"provider": strings.TrimSpace(route.ClientConfig.Provider),
		"model":    model,
	}
	if profile := strings.TrimSpace(route.Profile); profile != "" {
		out["profile"] = profile
	}
	if host := endpointHost(route.ClientConfig.Endpoint); host != "" {
		out["endpoint_host"] = host
	}
	if window := contextWindowTokens(route.ClientConfig.ContextWindowTokens, model); window > 0 {
		out["context_window_tokens"] = window
	}
	if effort := strings.ToLower(strings.TrimSpace(route.Values.ReasoningEffortRaw)); effort != "" {
		out["reasoning_effort"] = effort
	}
	// More than one candidate: the main loop spreads its requests over them by weight.
	if len(route.Candidates) > 1 {
		candidates := make([]map[string]any, 0, len(route.Candidates))
		for _, candidate := range route.Candidates {
			candidates = append(candidates, map[string]any{
				"profile": strings.TrimSpace(candidate.Profile),
				"model":   strings.TrimSpace(candidate.ClientConfig.Model),
				"weight":  candidate.Weight,
			})
		}
		out["candidates"] = candidates
	}
	if len(route.Fallbacks) > 0 {
		fallbacks := make([]map[string]any, 0, len(route.Fallbacks))
		for _, fallback := range route.Fallbacks {
			fallbacks = append(fallbacks, map[string]any{
				"profile":  strings.TrimSpace(fallback.Profile),
				"provider": strings.TrimSpace(fallback.ClientConfig.Provider),
				"model":    strings.TrimSpace(fallback.ClientConfig.Model),
			})
		}
		out["fallbacks"] = fallbacks
	}
	return out
}

// endpointHost is the endpoint's host (with its port), or "" when it has none to give.
func endpointHost(endpoint string) string {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return ""
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return ""
	}
	return parsed.Host
}

// contextWindowTokens is the window the agent works with: the configured one, else the catalog's
// for the model (llm/model_context_windows.yaml), else 0 (unknown, not reported).
func contextWindowTokens(configured int64, model string) int64 {
	if configured > 0 {
		return configured
	}
	if entry, ok := llm.ResolveModelContextWindow(model); ok && entry.ContextWindowTokens > 0 {
		return entry.ContextWindowTokens
	}
	return 0
}

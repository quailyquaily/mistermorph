package agent

import "github.com/quailyquaily/mistermorph/llm"

// The main loop's output budget, when the run's parameters do not set max_tokens. Some providers
// require max_tokens and their SDK fills in a default when it is missing (8192 for Anthropic), and a
// thinking model can spend that much reasoning before it writes a word. The budget is a ceiling,
// not a cost: only generated tokens are billed. A streamed request can take the larger one; an
// unstreamed one has to finish within the HTTP timeout.
const (
	streamingMainMaxOutputTokens    = 64000
	nonStreamingMainMaxOutputTokens = 16000
)

// mainRequestParameters is the run's parameters with max_tokens filled in from the model's output
// limit. A max_tokens the run sets is kept, and a model the catalog has no output limit for gets
// none, so its provider's default applies as before.
func mainRequestParameters(st *engineLoopState) map[string]any {
	if requestMaxOutputTokens(st.extraParams) > 0 {
		return st.extraParams
	}
	limit := mainMaxOutputTokens(st.model, st.onStream != nil)
	if limit <= 0 {
		return st.extraParams
	}
	parameters := cloneRequestParameters(st.extraParams)
	parameters["max_tokens"] = limit
	return parameters
}

func mainMaxOutputTokens(model string, streaming bool) int {
	entry, ok := llm.ResolveModelContextWindow(model)
	if !ok || entry.MaxOutputTokens <= 0 {
		return 0
	}
	budget := nonStreamingMainMaxOutputTokens
	if streaming {
		budget = streamingMainMaxOutputTokens
	}
	return int(min(int64(budget), entry.MaxOutputTokens))
}

package llmconfig

import "time"

type ClientConfig struct {
	Provider            string
	Endpoint            string
	APIKey              string
	Model               string
	ContextWindowTokens int64
	Headers             map[string]string
	RequestTimeout      time.Duration
	// EvaluateOnly marks a profile that answers only Evaluate requests (TypeSafe, or a profile
	// with decision_model), so it can serve only the decision route.
	EvaluateOnly bool
}

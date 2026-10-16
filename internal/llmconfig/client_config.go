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
	// EvaluateOnly marks a profile that answers only Evaluate requests (TypeSafe, or abilities
	// with decision but not text), so it can serve only the decision route.
	EvaluateOnly bool
}

package llm

import "fmt"

// Finish reasons, as providers report why a response ended. Empty means the provider did not say.
const (
	FinishReasonStop          = "stop"
	FinishReasonLength        = "length"
	FinishReasonToolCalls     = "tool_calls"
	FinishReasonContentFilter = "content_filter"
)

// EmptyResponseError is a response that held no answer, with what the provider said about why it
// ended. A response cut off at the output limit while the model was still thinking looks like any
// other empty answer unless the finish reason travels with it.
type EmptyResponseError struct {
	FinishReason string
	OutputTokens int
}

func (e *EmptyResponseError) Error() string {
	switch e.FinishReason {
	case FinishReasonLength:
		if e.OutputTokens > 0 {
			return fmt.Sprintf("response stopped at the output token limit (%d output tokens) before an answer", e.OutputTokens)
		}
		return "response stopped at the output token limit before an answer"
	case FinishReasonContentFilter:
		return "response was stopped by the provider's content filter"
	default:
		return "response held no answer"
	}
}

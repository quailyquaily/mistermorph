package llmutil

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

// RetryEvent describes a scheduled retry, emitted before the backoff begins.
// Reason is a display-safe description; raw provider errors stay in the log.
type RetryEvent struct {
	Model      string
	Profile    string
	Scene      string
	Attempt    int
	MaxRetries int
	Delay      time.Duration
	Reason     string
}

func (event RetryEvent) StatusText() string {
	return fmt.Sprintf("Request failed: %s. Retrying in %.1fs (%d/%d).", event.Reason, event.Delay.Seconds(), event.Attempt, event.MaxRetries)
}

type retryNotificationKey struct{}

// WithRetryNotification scopes notifications to a task and its child calls.
// The callback may be invoked concurrently by parallel model requests.
func WithRetryNotification(ctx context.Context, notify func(context.Context, RetryEvent)) context.Context {
	return context.WithValue(ctx, retryNotificationKey{}, notify)
}

// OpenAI-compatible SDK errors can use `POST "...": 504 Gateway Timeout`
// without the "status" or "HTTP" prefix recognized by fallbackHTTPStatus.
var retrySDKStatusPattern = regexp.MustCompile(`(?:^|:\s+)([45]\d{2})\s+[A-Za-z]`)

func retryReasonDescription(err error) string {
	var empty *llm.EmptyResponseError
	if errors.As(err, &empty) {
		return emptyResponseDescription(empty)
	}
	reason, _ := fallbackEligibleReason(err)
	if reason == "invalid_response" {
		return "Invalid model response"
	}
	message := err.Error()
	// A named cause says more than the status it came with ("HTTP 400" for an oversized prompt).
	if description, ok := matchRetryReason(retryCauseReasons, strings.ToLower(message)); ok {
		return description
	}
	status, ok := fallbackHTTPStatus(strings.ToLower(message))
	if !ok {
		if match := retrySDKStatusPattern.FindStringSubmatch(message); len(match) == 2 {
			status, _ = strconv.Atoi(match[1])
			ok = true
		}
	}
	if ok {
		return strings.TrimSpace(fmt.Sprintf("HTTP %d %s", status, http.StatusText(status)))
	}
	if reason == "status_429" {
		return "HTTP 429 Too Many Requests"
	}
	if reason == "timeout" {
		return "Request timed out"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "Response stream interrupted"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "Connection refused"
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return "Connection reset"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "DNS lookup failed"
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return "Network connection failed"
	}
	// Provider SDKs often flatten the cause into the message, so the types above are gone.
	if description, ok := retryReasonFromMessage(strings.ToLower(message)); ok {
		return description
	}
	return "Model service request failed"
}

// emptyResponseDescription says why a response held no answer. The output limit is the common
// case: a thinking model can spend the whole limit reasoning and stop before writing a word.
func emptyResponseDescription(e *llm.EmptyResponseError) string {
	switch e.FinishReason {
	case llm.FinishReasonLength:
		if e.OutputTokens > 0 {
			return fmt.Sprintf("Model hit its output limit (%d tokens) before answering", e.OutputTokens)
		}
		return "Model hit its output limit before answering"
	case llm.FinishReasonContentFilter:
		return "Response blocked by the provider's content filter"
	default:
		return "Model returned an empty answer"
	}
}

type retryMessageReason struct {
	needles     []string
	description string
}

// retryCauseReasons name what went wrong in the request itself; they are checked before the HTTP
// status, which only says that it went wrong.
var retryCauseReasons = []retryMessageReason{
	// The Responses API reports a cut-off response as an error rather than a finish reason.
	{[]string{"incomplete: max_output_tokens"}, "Model hit its output limit before answering"},
	{[]string{"incomplete: content_filter"}, "Response blocked by the provider's content filter"},
	{[]string{"context_length_exceeded", "maximum context length", "prompt is too long"}, "Request is larger than the model's context window"},
	{[]string{"insufficient_quota", "credit balance is too low"}, "Model account is out of quota or credit"},
}

var retryMessageReasons = []retryMessageReason{
	{[]string{"connection refused"}, "Connection refused"},
	{[]string{"connection reset", "broken pipe"}, "Connection reset"},
	{[]string{"no such host", "server misbehaving"}, "DNS lookup failed"},
	{[]string{"x509:", "tls:", "certificate"}, "TLS handshake failed"},
	{[]string{"unexpected eof", ": eof", "stream error"}, "Response stream interrupted"},
	{[]string{"network is unreachable", "no route to host", "dial tcp"}, "Network connection failed"},
	{[]string{"overloaded"}, "Model service overloaded"},
	{[]string{"invalid anthropic replay content", "marshaljson", "json: "}, "Request or response encoding failed"},
}

func retryReasonFromMessage(message string) (string, bool) {
	return matchRetryReason(retryMessageReasons, message)
}

func matchRetryReason(reasons []retryMessageReason, message string) (string, bool) {
	for _, entry := range reasons {
		for _, needle := range entry.needles {
			if strings.Contains(message, needle) {
				return entry.description, true
			}
		}
	}
	return "", false
}

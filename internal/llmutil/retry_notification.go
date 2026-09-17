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
	"time"
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
	reason, _ := fallbackEligibleReason(err)
	if reason == "invalid_response" {
		return "Invalid model response"
	}
	message := err.Error()
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
	if reason == "timeout" {
		return "Request timed out"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "Response stream interrupted"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "DNS lookup failed"
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return "Network connection failed"
	}
	return "Model service request failed"
}

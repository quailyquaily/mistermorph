// Package whatsappapi is the small client for the WhatsApp Agent Platform v1 that the WhatsApp
// channel needs: long-polled updates and text messages to the agent's creator. It follows the
// developer manual, Version 1 (2026-08-25); see
// docs/feat/feat_20261001_wechat_whatsapp_channels_research.md.
package whatsappapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultBaseURL = "https://api.whatsapp.com/agent/v1"
	// MaxTextLength is the most characters one text message can hold.
	MaxTextLength = 4096
	// MaxPollTimeout is the longest the server holds a poll open.
	MaxPollTimeout = 25 * time.Second

	maxResponseBytes = 8 << 20
	sendTimeout      = 60 * time.Second

	// Error codes the client acts on.
	CodePollReplaced        = 1752041
	CodeNotAcceptedDelivery = 131016
)

// Per-method limits, over a rolling minute and per agent.
const (
	sendsPerMinute   = 12
	updatesPerMinute = 15
)

type Options struct {
	BaseURL    string
	HTTPClient *http.Client
	Now        func() time.Time
	Sleep      func(context.Context, time.Duration) error
}

// Client is one agent's connection: the API token identifies the agent.
type Client struct {
	token   string
	baseURL string
	http    *http.Client
	now     func() time.Time
	sleep   func(context.Context, time.Duration) error

	sends   *rollingLimit
	updates *rollingLimit
	// Each media method has its own limit.
	mediaGets    *rollingLimit
	mediaUploads *rollingLimit
}

func NewClient(token string, opts Options) (*Client, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("whatsapp api token is required")
	}
	base := strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/")
	if base == "" {
		base = DefaultBaseURL
	}
	if parsed, err := url.Parse(base); err != nil || parsed.Host == "" || parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, fmt.Errorf("whatsapp api base url is invalid: %q", opts.BaseURL)
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	sleep := opts.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	return &Client{
		token: token, baseURL: base, http: client, now: now, sleep: sleep,
		sends:        newRollingLimit(sendsPerMinute, time.Minute),
		updates:      newRollingLimit(updatesPerMinute, time.Minute),
		mediaGets:    newRollingLimit(mediaPerMinute, time.Minute),
		mediaUploads: newRollingLimit(mediaPerMinute, time.Minute),
	}, nil
}

// APIError is an error response: the HTTP status and the error object's code.
type APIError struct {
	HTTPStatus int
	Code       int
	Message    string
	Details    string
	TraceID    string
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("whatsapp: HTTP %d", e.HTTPStatus)
	if e.Code != 0 {
		msg += fmt.Sprintf(" code %d", e.Code)
	}
	if e.Details != "" {
		msg += ": " + e.Details
	} else if e.Message != "" {
		msg += ": " + e.Message
	}
	return msg
}

// ErrPollReplaced is a poll that a newer poll for the same agent replaced: another process is
// polling this agent.
var ErrPollReplaced = errors.New("whatsapp: another poll for this agent replaced this one; run one poller per agent")

// ErrSendUnknown is a send whose outcome is unknown (a 500, a reset or a timeout): the message may
// or may not have been sent, so it is not retried.
var ErrSendUnknown = errors.New("whatsapp: it is unknown whether the message was sent")

// IsUnauthorized reports a missing, malformed or invalid token: retrying does not help.
func IsUnauthorized(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.HTTPStatus == http.StatusUnauthorized || apiErr.HTTPStatus == http.StatusBadRequest && apiErr.Code == 100 && strings.Contains(strings.ToLower(apiErr.Message+apiErr.Details), "token")
}

// IsRetryable reports an error worth retrying after backing off: too many requests, or a send the
// server said it did not accept.
func IsRetryable(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.HTTPStatus == http.StatusTooManyRequests || apiErr.HTTPStatus == http.StatusServiceUnavailable && apiErr.Code == CodeNotAcceptedDelivery
}

func (c *Client) request(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// do sends req and decodes a 2xx body into out. It returns the status, so 204 can be told apart.
func (c *Client) do(req *http.Request, out any) (int, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode/100 != 2 {
		return resp.StatusCode, decodeError(resp.StatusCode, raw)
	}
	if out != nil && resp.StatusCode != http.StatusNoContent && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp.StatusCode, fmt.Errorf("whatsapp: invalid response: %w", err)
		}
	}
	return resp.StatusCode, nil
}

func decodeError(status int, raw []byte) error {
	var body struct {
		Error struct {
			Message   string `json:"message"`
			Code      int    `json:"code"`
			ErrorData struct {
				Details string `json:"details"`
			} `json:"error_data"`
			TraceID string `json:"fbtrace_id"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	return &APIError{
		HTTPStatus: status, Code: body.Error.Code, Message: strings.TrimSpace(body.Error.Message),
		Details: strings.TrimSpace(body.Error.ErrorData.Details), TraceID: strings.TrimSpace(body.Error.TraceID),
	}
}

func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// rollingLimit allows max calls in any window, counting calls as they start: the server counts per
// method over a rolling minute, so waiting for a 429 would already be too late.
type rollingLimit struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	starts []time.Time
}

func newRollingLimit(max int, window time.Duration) *rollingLimit {
	return &rollingLimit{max: max, window: window}
}

// wait blocks until a call may start, then records it.
func (l *rollingLimit) wait(ctx context.Context, now func() time.Time, sleep func(context.Context, time.Duration) error) error {
	for {
		l.mu.Lock()
		current := now()
		kept := l.starts[:0]
		for _, start := range l.starts {
			if current.Sub(start) < l.window {
				kept = append(kept, start)
			}
		}
		l.starts = kept
		if len(l.starts) < l.max {
			l.starts = append(l.starts, current)
			l.mu.Unlock()
			return nil
		}
		delay := l.window - current.Sub(l.starts[0])
		l.mu.Unlock()
		if err := sleep(ctx, delay); err != nil {
			return err
		}
	}
}

func formatOffset(offset int64) string {
	return strconv.FormatInt(offset, 10)
}

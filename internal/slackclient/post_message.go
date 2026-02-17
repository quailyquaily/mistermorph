package slackclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const defaultBaseURL = "https://slack.com/api"

type Client struct {
	http     *http.Client
	baseURL  string
	botToken string
}

func New(httpClient *http.Client, baseURL, botToken string) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	baseURL = strings.TrimSpace(strings.TrimRight(baseURL, "/"))
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	return &Client{
		http:     httpClient,
		baseURL:  baseURL,
		botToken: strings.TrimSpace(botToken),
	}
}

func (c *Client) PostMessage(ctx context.Context, channelID, text, threadTS string) error {
	if c == nil || c.http == nil {
		return fmt.Errorf("slack client is not initialized")
	}
	token := strings.TrimSpace(c.botToken)
	if token == "" {
		return fmt.Errorf("slack token is required")
	}
	channelID = strings.TrimSpace(channelID)
	text = strings.TrimSpace(text)
	threadTS = strings.TrimSpace(threadTS)
	if channelID == "" {
		return fmt.Errorf("channel_id is required")
	}
	if text == "" {
		return fmt.Errorf("text is required")
	}

	type requestBody struct {
		Channel  string `json:"channel"`
		Text     string `json:"text"`
		ThreadTS string `json:"thread_ts,omitempty"`
	}
	type responseBody struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	}

	payload := requestBody{
		Channel:  channelID,
		Text:     text,
		ThreadTS: threadTS,
	}
	const maxAttempts = 3
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		bodyRaw, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("marshal slack payload: %w", err)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat.postMessage", bytes.NewReader(bodyRaw))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")

		resp, err := c.http.Do(req)
		status := 0
		headers := http.Header{}
		if err != nil {
			lastErr = err
		} else {
			status = resp.StatusCode
			headers = resp.Header
			respRaw, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if readErr != nil {
				lastErr = readErr
			} else {
				var out responseBody
				if parseErr := json.Unmarshal(respRaw, &out); parseErr != nil {
					lastErr = parseErr
				} else if status < 200 || status >= 300 {
					lastErr = fmt.Errorf("slack chat.postMessage http %d", status)
				} else if out.OK {
					return nil
				} else {
					code := strings.TrimSpace(out.Error)
					if code == "" {
						code = "unknown_error"
					}
					lastErr = fmt.Errorf("slack chat.postMessage failed: %s", code)
				}
			}
		}

		if attempt >= maxAttempts {
			break
		}
		if status == 0 {
			status = http.StatusBadGateway
		}
		wait, retryable := retryDelay(status, headers, attempt)
		if !retryable {
			break
		}
		if err := sleepWithContext(ctx, wait); err != nil {
			return err
		}
	}
	return lastErr
}

func retryDelay(status int, headers http.Header, attempt int) (time.Duration, bool) {
	switch {
	case status == http.StatusTooManyRequests:
		retryAfter := strings.TrimSpace(headers.Get("Retry-After"))
		if retryAfter == "" {
			return 1 * time.Second, true
		}
		secs, err := strconv.Atoi(retryAfter)
		if err != nil || secs <= 0 {
			return 1 * time.Second, true
		}
		return time.Duration(secs) * time.Second, true
	case status >= 500 && status <= 599:
		switch attempt {
		case 1:
			return 300 * time.Millisecond, true
		case 2:
			return 1 * time.Second, true
		default:
			return 2 * time.Second, true
		}
	default:
		return 0, false
	}
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
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

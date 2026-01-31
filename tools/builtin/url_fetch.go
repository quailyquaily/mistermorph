package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type URLFetchTool struct {
	Enabled     bool
	Timeout     time.Duration
	MaxBytes    int64
	UserAgent   string
	HTTPClient  *http.Client
	AllowScheme map[string]bool
}

func NewURLFetchTool(enabled bool, timeout time.Duration, maxBytes int64, userAgent string) *URLFetchTool {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if maxBytes <= 0 {
		maxBytes = 512 * 1024
	}
	if strings.TrimSpace(userAgent) == "" {
		userAgent = "mister_morph/1.0 (+https://github.com/quailyquaily)"
	}
	return &URLFetchTool{
		Enabled:   enabled,
		Timeout:   timeout,
		MaxBytes:  maxBytes,
		UserAgent: userAgent,
		HTTPClient: &http.Client{
			Timeout: timeout,
		},
		AllowScheme: map[string]bool{"http": true, "https": true},
	}
}

func (t *URLFetchTool) Name() string { return "url_fetch" }

func (t *URLFetchTool) Description() string {
	return "Fetches the content of an HTTP(S) URL and returns the response body (truncated)."
}

func (t *URLFetchTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"url": map[string]any{
				"type":        "string",
				"description": "URL to fetch (http/https).",
			},
			"timeout_seconds": map[string]any{
				"type":        "number",
				"description": "Optional timeout override in seconds.",
			},
			"max_bytes": map[string]any{
				"type":        "integer",
				"description": "Optional max response bytes to read (truncates beyond this).",
			},
		},
		"required": []string{"url"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *URLFetchTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !t.Enabled {
		return "", fmt.Errorf("url_fetch tool is disabled (enable via config: tools.url_fetch.enabled=true)")
	}

	rawURL, _ := params["url"].(string)
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", fmt.Errorf("missing required param: url")
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("invalid url: %w", err)
	}
	if !t.AllowScheme[strings.ToLower(u.Scheme)] {
		return "", fmt.Errorf("unsupported url scheme: %s", u.Scheme)
	}

	timeout := t.Timeout
	if v, ok := params["timeout_seconds"]; ok {
		if secs, ok := asFloat64(v); ok && secs > 0 {
			timeout = time.Duration(secs * float64(time.Second))
		}
	}

	maxBytes := t.MaxBytes
	if v, ok := params["max_bytes"]; ok {
		if n, ok := asInt64(v); ok && n > 0 {
			maxBytes = n
		}
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", t.UserAgent)

	client := t.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var truncated bool
	limitReader := io.LimitReader(resp.Body, maxBytes+1)
	body, err := io.ReadAll(limitReader)
	if err != nil {
		return "", err
	}
	if int64(len(body)) > maxBytes {
		body = body[:maxBytes]
		truncated = true
	}

	ct := resp.Header.Get("Content-Type")

	var b strings.Builder
	fmt.Fprintf(&b, "url: %s\n", u.String())
	fmt.Fprintf(&b, "status: %d\n", resp.StatusCode)
	if ct != "" {
		fmt.Fprintf(&b, "content_type: %s\n", ct)
	}
	fmt.Fprintf(&b, "truncated: %t\n", truncated)
	b.WriteString("body:\n")
	b.WriteString(string(bytes.ToValidUTF8(body, []byte("\n[non-utf8 body]\n"))))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return b.String(), fmt.Errorf("non-2xx status: %d", resp.StatusCode)
	}
	return b.String(), nil
}

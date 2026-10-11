// Package xapi is the small X API v2 client the X channel needs: OAuth 2.0 user tokens, mentions,
// post lookup and replies, and direct messages. X bills each call (pay-per-use), so the client
// counts what it reads and writes. See docs/feat/feat_20261011_x_bluesky_channels.md.
package xapi

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
	DefaultBaseURL  = "https://api.x.com/2"
	DefaultTokenURL = "https://api.x.com/2/oauth2/token"
	AuthorizeURL    = "https://x.com/i/oauth2/authorize"
	// Scopes are what the channel asks for: reading and posting, direct messages, and a refresh token.
	Scopes = "tweet.read tweet.write users.read dm.read dm.write offline.access"
	// MaxPostWeight is a post's limit in X's weighted characters; MaxDMLength a direct message's.
	MaxPostWeight = 280
	MaxDMLength   = 10000

	maxResponseBytes = 8 << 20
	maxRetryWait     = 15 * time.Minute
	// refreshMargin renews a token this long before it expires.
	refreshMargin = 2 * time.Minute
)

// Token is an OAuth 2.0 user token pair.
type Token struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	// Seed is the configured refresh token this pair descends from; a new one in config (after a
	// new login) replaces the saved pair.
	Seed string `json:"seed,omitempty"`
	// UserID and Username name the account that authorized the pair.
	UserID   string `json:"user_id,omitempty"`
	Username string `json:"username,omitempty"`
}

// TokenStore keeps the token pair: X rotates the refresh token on every refresh, so the latest one
// must be saved or the next start cannot authenticate.
type TokenStore interface {
	Load() (Token, bool)
	Save(Token) error
}

type Options struct {
	ClientID     string
	ClientSecret string
	RefreshToken string
	Store        TokenStore
	BaseURL      string
	TokenURL     string
	HTTPClient   *http.Client
	Now          func() time.Time
	Sleep        func(context.Context, time.Duration) error
}

// Client is the agent account's connection.
type Client struct {
	clientID     string
	clientSecret string
	baseURL      string
	tokenURL     string
	store        TokenStore
	http         *http.Client
	now          func() time.Time
	sleep        func(context.Context, time.Duration) error
	usage        *Usage

	mu    sync.Mutex
	token Token
}

func NewClient(opts Options) (*Client, error) {
	clientID := strings.TrimSpace(opts.ClientID)
	if clientID == "" {
		return nil, fmt.Errorf("x client id is required")
	}
	seed := strings.TrimSpace(opts.RefreshToken)
	base := strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/")
	if base == "" {
		base = DefaultBaseURL
	}
	tokenURL := strings.TrimSpace(opts.TokenURL)
	if tokenURL == "" {
		tokenURL = DefaultTokenURL
	}
	for _, raw := range []string{base, tokenURL} {
		if parsed, err := url.Parse(raw); err != nil || parsed.Host == "" || parsed.Scheme != "https" && parsed.Scheme != "http" {
			return nil, fmt.Errorf("x api url is invalid: %q", raw)
		}
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	sleep := opts.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	c := &Client{
		clientID: clientID, clientSecret: strings.TrimSpace(opts.ClientSecret), baseURL: base, tokenURL: tokenURL,
		store: opts.Store, http: client, now: now, sleep: sleep, usage: newUsage(now),
		token: Token{RefreshToken: seed, Seed: seed},
	}
	if c.store != nil {
		if saved, ok := c.store.Load(); ok && saved.RefreshToken != "" && (seed == "" || saved.Seed == seed) {
			c.token = saved
		}
	}
	if c.token.RefreshToken == "" && c.token.AccessToken == "" {
		return nil, fmt.Errorf("x is not logged in: run `morph x login`")
	}
	return c, nil
}

// Usage is what the client read and wrote today.
func (c *Client) Usage() UsageSnapshot { return c.usage.snapshot() }

// APIError is an error response.
type APIError struct {
	HTTPStatus int
	Title      string
	Detail     string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("x: HTTP %d", e.HTTPStatus)
	if e.Title != "" {
		msg += " " + e.Title
	}
	if e.Detail != "" {
		msg += ": " + e.Detail
	}
	return msg
}

// IsUnauthorized reports a token X refused: a new login is needed.
func IsUnauthorized(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && (apiErr.HTTPStatus == http.StatusUnauthorized || apiErr.Title == "invalid_grant")
}

// IsOutOfCredits reports an account whose prepaid credits are used up or whose spending limit is
// reached.
func IsOutOfCredits(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	text := strings.ToLower(apiErr.Title + " " + apiErr.Detail)
	return apiErr.HTTPStatus == http.StatusPaymentRequired || strings.Contains(text, "credit") || strings.Contains(text, "spend")
}

// IsForbidden reports a call the app or account may not make (a missing scope, an unapproved use,
// or a user who does not accept messages).
func IsForbidden(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.HTTPStatus == http.StatusForbidden
}

// accessToken returns a valid access token, refreshing it when it is missing or about to expire.
func (c *Client) accessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	token := c.token
	c.mu.Unlock()
	if token.AccessToken != "" && c.now().Add(refreshMargin).Before(token.ExpiresAt) {
		return token.AccessToken, nil
	}
	if err := c.refresh(ctx); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.token.AccessToken, nil
}

// refresh trades the refresh token for a new pair and saves it.
func (c *Client) refresh(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token.AccessToken != "" && c.now().Add(refreshMargin).Before(c.token.ExpiresAt) {
		return nil
	}
	if c.token.RefreshToken == "" {
		return &APIError{HTTPStatus: http.StatusUnauthorized, Title: "invalid_grant", Detail: "no refresh token; run `morph x login`"}
	}
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.token.RefreshToken}, "client_id": {c.clientID}}
	next, err := c.exchange(ctx, form)
	if err != nil {
		return err
	}
	next.Seed, next.UserID, next.Username = c.token.Seed, c.token.UserID, c.token.Username
	c.token = next
	if c.store != nil {
		if err := c.store.Save(next); err != nil {
			return fmt.Errorf("x: save the rotated token: %w", err)
		}
	}
	return nil
}

// exchange posts a token request and reads the token pair.
func (c *Client) exchange(ctx context.Context, form url.Values) (Token, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if c.clientSecret != "" {
		req.SetBasicAuth(url.QueryEscape(c.clientID), url.QueryEscape(c.clientSecret))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return Token{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Token{}, err
	}
	var body struct {
		AccessToken      string `json:"access_token"`
		RefreshToken     string `json:"refresh_token"`
		ExpiresIn        int64  `json:"expires_in"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	_ = json.Unmarshal(raw, &body)
	if resp.StatusCode/100 != 2 || body.AccessToken == "" {
		title := firstNonEmpty(body.Error, "token_request_failed")
		status := resp.StatusCode
		if title == "invalid_request" || title == "invalid_grant" {
			// A used or revoked refresh token.
			title, status = "invalid_grant", http.StatusUnauthorized
		}
		return Token{}, &APIError{HTTPStatus: status, Title: title, Detail: body.ErrorDescription}
	}
	expiresIn := time.Duration(body.ExpiresIn) * time.Second
	if expiresIn <= 0 {
		expiresIn = 2 * time.Hour
	}
	return Token{AccessToken: body.AccessToken, RefreshToken: body.RefreshToken, ExpiresAt: c.now().Add(expiresIn)}, nil
}

// call sends a request with the access token, refreshing once on 401 and waiting out a 429.
func (c *Client) call(ctx context.Context, method, path string, params url.Values, body, out any) error {
	for attempt := 0; ; attempt++ {
		token, err := c.accessToken(ctx)
		if err != nil {
			return err
		}
		err = c.do(ctx, method, path, params, body, out, token)
		if err == nil {
			return nil
		}
		var apiErr *APIError
		if !errors.As(err, &apiErr) || attempt >= 2 {
			return err
		}
		switch apiErr.HTTPStatus {
		case http.StatusUnauthorized:
			c.mu.Lock()
			c.token.AccessToken = ""
			c.mu.Unlock()
			continue
		case http.StatusTooManyRequests:
			wait := min(max(apiErr.RetryAfter, time.Second), maxRetryWait)
			if err := c.sleep(ctx, wait); err != nil {
				return err
			}
			continue
		}
		return err
	}
}

func (c *Client) do(ctx context.Context, method, path string, params url.Values, body, out any, token string) error {
	endpoint := c.baseURL + path
	if len(params) > 0 {
		endpoint += "?" + params.Encode()
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return decodeError(resp, raw, c.now())
	}
	if out != nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("x: invalid response from %s: %w", path, err)
		}
	}
	return nil
}

func decodeError(resp *http.Response, raw []byte, now time.Time) error {
	var body struct {
		Title  string `json:"title"`
		Detail string `json:"detail"`
		Errors []struct {
			Message string `json:"message"`
			Title   string `json:"title"`
		} `json:"errors"`
	}
	_ = json.Unmarshal(raw, &body)
	apiErr := &APIError{HTTPStatus: resp.StatusCode, Title: strings.TrimSpace(body.Title), Detail: strings.TrimSpace(body.Detail)}
	if apiErr.Detail == "" && len(body.Errors) > 0 {
		apiErr.Detail = strings.TrimSpace(body.Errors[0].Message)
		apiErr.Title = firstNonEmpty(apiErr.Title, body.Errors[0].Title)
	}
	if reset, err := strconv.ParseInt(strings.TrimSpace(resp.Header.Get("x-rate-limit-reset")), 10, 64); err == nil {
		apiErr.RetryAfter = time.Unix(reset, 0).Sub(now)
	}
	return apiErr
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

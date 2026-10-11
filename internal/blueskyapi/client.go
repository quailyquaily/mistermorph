// Package blueskyapi is the small AT Protocol client the Bluesky channel needs: an app-password
// session, direct messages through the chat service, mention notifications, threads and posts.
// See docs/feat/feat_20261011_x_bluesky_channels.md.
package blueskyapi

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
	DefaultServiceURL = "https://bsky.social"
	// ChatProxy names the chat service; requests carrying it are forwarded there by the PDS.
	ChatProxy = "did:web:api.bsky.chat#bsky_chat"
	// MaxMessageGraphemes is the longest direct message; MaxPostGraphemes the longest post.
	MaxMessageGraphemes = 1000
	MaxPostGraphemes    = 300

	maxResponseBytes = 8 << 20
	maxRetryWait     = time.Minute
)

// Session is a logged-in session. RefreshJWT outlives AccessJWT and renews it.
type Session struct {
	DID        string `json:"did"`
	Handle     string `json:"handle"`
	AccessJWT  string `json:"access_jwt"`
	RefreshJWT string `json:"refresh_jwt"`
}

// SessionStore keeps the session between runs, so a restart refreshes it instead of logging in
// again: logins have a much lower rate limit than other calls.
type SessionStore interface {
	Load() (Session, bool)
	Save(Session) error
}

type Options struct {
	ServiceURL  string
	Identifier  string
	AppPassword string
	Store       SessionStore
	HTTPClient  *http.Client
	Now         func() time.Time
	Sleep       func(context.Context, time.Duration) error
}

// Client is one account's connection.
type Client struct {
	service    string
	identifier string
	password   string
	store      SessionStore
	http       *http.Client
	now        func() time.Time
	sleep      func(context.Context, time.Duration) error

	mu      sync.Mutex
	session Session
}

func NewClient(opts Options) (*Client, error) {
	identifier := strings.TrimPrefix(strings.TrimSpace(opts.Identifier), "@")
	if identifier == "" {
		return nil, fmt.Errorf("bluesky identifier (handle or DID) is required")
	}
	if strings.TrimSpace(opts.AppPassword) == "" {
		return nil, fmt.Errorf("bluesky app password is required")
	}
	service := strings.TrimRight(strings.TrimSpace(opts.ServiceURL), "/")
	if service == "" {
		service = DefaultServiceURL
	}
	if parsed, err := url.Parse(service); err != nil || parsed.Host == "" || parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, fmt.Errorf("bluesky service url is invalid: %q", opts.ServiceURL)
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
		service: service, identifier: identifier, password: strings.TrimSpace(opts.AppPassword),
		store: opts.Store, http: client, now: now, sleep: sleep,
	}
	if c.store != nil {
		if saved, ok := c.store.Load(); ok && saved.RefreshJWT != "" && sameAccount(saved, identifier) {
			c.session = saved
		}
	}
	return c, nil
}

func sameAccount(s Session, identifier string) bool {
	identifier = strings.ToLower(identifier)
	return strings.EqualFold(s.DID, identifier) || strings.EqualFold(s.Handle, identifier)
}

// DID is the account's DID, "" before the first successful call.
func (c *Client) DID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session.DID
}

// Handle is the account's handle, "" before the first successful call.
func (c *Client) Handle() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session.Handle
}

// APIError is an XRPC error response.
type APIError struct {
	HTTPStatus int
	Name       string
	Message    string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("bluesky: HTTP %d", e.HTTPStatus)
	if e.Name != "" {
		msg += " " + e.Name
	}
	if e.Message != "" {
		msg += ": " + e.Message
	}
	return msg
}

// IsUnauthorized reports credentials the server refused: retrying does not help until they change.
func IsUnauthorized(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	switch apiErr.Name {
	case "AuthenticationRequired", "AccountTakedown", "AccountDeactivated", "InvalidToken":
		return true
	}
	return apiErr.HTTPStatus == http.StatusUnauthorized
}

// IsMissingScope reports an app password made without access to direct messages.
func IsMissingScope(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	text := strings.ToLower(apiErr.Name + " " + apiErr.Message)
	return strings.Contains(text, "scope") || strings.Contains(text, "xrpcnotsupported") || strings.Contains(text, "bad token method")
}

func isExpired(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.Name == "ExpiredToken" || apiErr.Name == "InvalidToken" && apiErr.HTTPStatus == http.StatusBadRequest
}

// login opens a new session with the app password.
func (c *Client) login(ctx context.Context) error {
	var out Session
	raw := struct {
		DID        string `json:"did"`
		Handle     string `json:"handle"`
		AccessJWT  string `json:"accessJwt"`
		RefreshJWT string `json:"refreshJwt"`
	}{}
	if err := c.call(ctx, http.MethodPost, "com.atproto.server.createSession", nil,
		map[string]string{"identifier": c.identifier, "password": c.password}, &raw, "", ""); err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.HTTPStatus == http.StatusUnauthorized {
			apiErr.Name = firstNonEmpty(apiErr.Name, "AuthenticationRequired")
		}
		return err
	}
	out = Session{DID: raw.DID, Handle: raw.Handle, AccessJWT: raw.AccessJWT, RefreshJWT: raw.RefreshJWT}
	c.setSession(out)
	return nil
}

// refresh renews the session with its refresh token.
func (c *Client) refresh(ctx context.Context) error {
	c.mu.Lock()
	refreshJWT := c.session.RefreshJWT
	c.mu.Unlock()
	if refreshJWT == "" {
		return c.login(ctx)
	}
	raw := struct {
		DID        string `json:"did"`
		Handle     string `json:"handle"`
		AccessJWT  string `json:"accessJwt"`
		RefreshJWT string `json:"refreshJwt"`
	}{}
	if err := c.call(ctx, http.MethodPost, "com.atproto.server.refreshSession", nil, nil, &raw, refreshJWT, ""); err != nil {
		// A refresh token that expired or was revoked: log in again.
		return c.login(ctx)
	}
	c.setSession(Session{DID: raw.DID, Handle: raw.Handle, AccessJWT: raw.AccessJWT, RefreshJWT: raw.RefreshJWT})
	return nil
}

func (c *Client) setSession(s Session) {
	c.mu.Lock()
	c.session = s
	c.mu.Unlock()
	if c.store != nil {
		_ = c.store.Save(s)
	}
}

// Connect makes sure there is a session, logging in when there is none.
func (c *Client) Connect(ctx context.Context) error {
	c.mu.Lock()
	access, refresh := c.session.AccessJWT, c.session.RefreshJWT
	c.mu.Unlock()
	switch {
	case access == "" && refresh == "":
		return c.login(ctx)
	case access == "":
		return c.refresh(ctx)
	}
	return nil
}

// xrpc calls a method with the session, renewing it once when it expired.
func (c *Client) xrpc(ctx context.Context, method, nsid string, params url.Values, body, out any, proxy string) error {
	if err := c.Connect(ctx); err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		c.mu.Lock()
		token := c.session.AccessJWT
		c.mu.Unlock()
		err := c.call(ctx, method, nsid, params, body, out, token, proxy)
		if err == nil {
			return nil
		}
		if attempt == 0 && (isExpired(err) || IsUnauthorized(err) && token != "") {
			if refreshErr := c.refresh(ctx); refreshErr != nil {
				return refreshErr
			}
			continue
		}
		var apiErr *APIError
		if attempt < 2 && errors.As(err, &apiErr) && apiErr.HTTPStatus == http.StatusTooManyRequests {
			wait := min(max(apiErr.RetryAfter, time.Second), maxRetryWait)
			if sleepErr := c.sleep(ctx, wait); sleepErr != nil {
				return sleepErr
			}
			continue
		}
		return err
	}
}

func (c *Client) call(ctx context.Context, method, nsid string, params url.Values, body, out any, token, proxy string) error {
	endpoint := c.service + "/xrpc/" + nsid
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
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if proxy != "" {
		req.Header.Set("atproto-proxy", proxy)
	}
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
			return fmt.Errorf("bluesky: invalid %s response: %w", nsid, err)
		}
	}
	return nil
}

func decodeError(resp *http.Response, raw []byte, now time.Time) error {
	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &body)
	apiErr := &APIError{HTTPStatus: resp.StatusCode, Name: strings.TrimSpace(body.Error), Message: strings.TrimSpace(body.Message)}
	// ratelimit-reset is the Unix time at which the window resets.
	if reset, err := strconv.ParseInt(strings.TrimSpace(resp.Header.Get("ratelimit-reset")), 10, 64); err == nil {
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

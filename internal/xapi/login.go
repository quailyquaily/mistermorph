package xapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// LoginOptions configure the OAuth 2.0 authorization-code login with PKCE.
type LoginOptions struct {
	ClientID     string
	ClientSecret string
	// RedirectURL must be registered as a callback URL of the X app, on 127.0.0.1 or localhost.
	RedirectURL string
	BaseURL     string
	TokenURL    string
	HTTPClient  *http.Client
}

// DefaultRedirectURL is the callback the login listens on unless told otherwise.
const DefaultRedirectURL = "http://127.0.0.1:8765/x/callback"

// ErrLoginPending is Result's answer while the person has not come back from X yet.
var ErrLoginPending = errors.New("x login is still waiting for the browser")

// LoginSession is a login waiting for the person to approve on X: it listens on the redirect URL
// until X sends them back, then trades the code for a token pair.
type LoginSession struct {
	// AuthorizeURL is the page to open, signed in as the agent's account.
	AuthorizeURL string

	opts     LoginOptions
	redirect string
	verifier string
	server   *http.Server
	done     chan struct{}

	mu    sync.Mutex
	token Token
	err   error
}

// StartLogin listens on the redirect URL and returns the session. Close it when done with it.
func StartLogin(opts LoginOptions) (*LoginSession, error) {
	clientID := strings.TrimSpace(opts.ClientID)
	if clientID == "" {
		return nil, fmt.Errorf("x client id is required")
	}
	redirect := strings.TrimSpace(opts.RedirectURL)
	if redirect == "" {
		redirect = DefaultRedirectURL
	}
	parsed, err := url.Parse(redirect)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") || parsed.Port() == "" {
		return nil, fmt.Errorf("x redirect url must be http://127.0.0.1:<port>/<path>: %q", redirect)
	}
	verifier, err := randomString(48)
	if err != nil {
		return nil, err
	}
	state, err := randomString(24)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(verifier))
	session := &LoginSession{
		AuthorizeURL: AuthorizeURL + "?" + url.Values{
			"response_type":         {"code"},
			"client_id":             {clientID},
			"redirect_uri":          {redirect},
			"scope":                 {Scopes},
			"state":                 {state},
			"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
			"code_challenge_method": {"S256"},
		}.Encode(),
		opts: opts, redirect: redirect, verifier: verifier, done: make(chan struct{}),
	}
	listener, err := net.Listen("tcp", parsed.Host)
	if err != nil {
		return nil, fmt.Errorf("listen for the x callback on %s (is another login running?): %w", parsed.Host, err)
	}
	path := parsed.Path
	if path == "" {
		path = "/"
	}
	var once sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("state") != state {
			http.Error(w, "state does not match", http.StatusBadRequest)
			return
		}
		once.Do(func() {
			if failure := query.Get("error"); failure != "" {
				session.finish(Token{}, fmt.Errorf("x authorization failed: %s", failure))
				fmt.Fprintln(w, "X login failed. You can close this tab.")
				return
			}
			token, err := session.exchange(r.Context(), query.Get("code"))
			session.finish(token, err)
			if err != nil {
				fmt.Fprintf(w, "X login failed: %v\n", err)
				return
			}
			fmt.Fprintf(w, "Logged in to X as @%s. You can close this tab.\n", token.Username)
		})
	})
	session.server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = session.server.Serve(listener) }()
	return session, nil
}

func (s *LoginSession) finish(token Token, err error) {
	s.mu.Lock()
	s.token, s.err = token, err
	s.mu.Unlock()
	close(s.done)
}

// exchange trades the authorization code for a token pair, and reads which account it belongs to.
func (s *LoginSession) exchange(ctx context.Context, code string) (Token, error) {
	if code == "" {
		return Token{}, fmt.Errorf("x sent no authorization code")
	}
	client := &Client{
		clientID: strings.TrimSpace(s.opts.ClientID), clientSecret: strings.TrimSpace(s.opts.ClientSecret),
		tokenURL: firstNonEmpty(s.opts.TokenURL, DefaultTokenURL), baseURL: strings.TrimRight(firstNonEmpty(s.opts.BaseURL, DefaultBaseURL), "/"),
		http: s.opts.HTTPClient, now: time.Now, sleep: sleepContext,
	}
	if client.http == nil {
		client.http = &http.Client{Timeout: 60 * time.Second}
	}
	client.usage = newUsage(client.now)
	token, err := client.exchange(ctx, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {s.redirect},
		"code_verifier": {s.verifier},
		"client_id":     {client.clientID},
	})
	if err != nil {
		return Token{}, err
	}
	if token.RefreshToken == "" {
		return Token{}, fmt.Errorf("x returned no refresh token; the app must request offline.access")
	}
	token.Seed = token.RefreshToken
	client.token = token
	me, err := client.Me(ctx)
	if err != nil {
		return Token{}, fmt.Errorf("read the authorized account: %w", err)
	}
	token.UserID, token.Username = me.ID, me.Username
	return token, nil
}

// Wait waits until the person comes back from X, or ctx ends.
func (s *LoginSession) Wait(ctx context.Context) (Token, error) {
	select {
	case <-s.done:
		return s.Result()
	case <-ctx.Done():
		return Token{}, ctx.Err()
	}
}

// Result is the login's outcome, or ErrLoginPending before the person came back.
func (s *LoginSession) Result() (Token, error) {
	select {
	case <-s.done:
	default:
		return Token{}, ErrLoginPending
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token, s.err
}

// Close stops listening.
func (s *LoginSession) Close() {
	if s != nil && s.server != nil {
		_ = s.server.Close()
	}
}

func randomString(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

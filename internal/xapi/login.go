package xapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// LoginOptions configure the OAuth 2.0 authorization-code login with PKCE.
type LoginOptions struct {
	ClientID     string
	ClientSecret string
	// RedirectURL must be registered as a callback URL of the X app, on 127.0.0.1 or localhost.
	RedirectURL string
	TokenURL    string
	HTTPClient  *http.Client
	// OpenURL shows the authorization URL to the person logging in.
	OpenURL func(authorizeURL string)
	Timeout time.Duration
}

// DefaultRedirectURL is the callback the login listens on unless told otherwise.
const DefaultRedirectURL = "http://127.0.0.1:8765/x/callback"

// Login runs the authorization-code flow: it shows the authorization URL, waits on the redirect URL
// for X to send the person back, and trades the code for a token pair.
func Login(ctx context.Context, opts LoginOptions) (Token, error) {
	clientID := strings.TrimSpace(opts.ClientID)
	if clientID == "" {
		return Token{}, fmt.Errorf("x client id is required")
	}
	redirect := strings.TrimSpace(opts.RedirectURL)
	if redirect == "" {
		redirect = DefaultRedirectURL
	}
	parsed, err := url.Parse(redirect)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") || parsed.Port() == "" {
		return Token{}, fmt.Errorf("x redirect url must be http://127.0.0.1:<port>/<path>: %q", redirect)
	}
	verifier, err := randomString(48)
	if err != nil {
		return Token{}, err
	}
	state, err := randomString(24)
	if err != nil {
		return Token{}, err
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	authorize := AuthorizeURL + "?" + url.Values{
		"response_type":         {"code"},
		"client_id":             {clientID},
		"redirect_uri":          {redirect},
		"scope":                 {Scopes},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}.Encode()

	listener, err := net.Listen("tcp", parsed.Host)
	if err != nil {
		return Token{}, fmt.Errorf("listen for the x callback on %s: %w", parsed.Host, err)
	}
	codes := make(chan string, 1)
	failures := make(chan error, 1)
	path := parsed.Path
	if path == "" {
		path = "/"
	}
	mux := http.NewServeMux()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		switch {
		case query.Get("state") != state:
			http.Error(w, "state does not match", http.StatusBadRequest)
			return
		case query.Get("error") != "":
			fmt.Fprintln(w, "X login failed. You can close this tab.")
			failures <- fmt.Errorf("x authorization failed: %s", query.Get("error"))
			return
		case query.Get("code") == "":
			http.Error(w, "missing code", http.StatusBadRequest)
			return
		}
		fmt.Fprintln(w, "X login complete. You can close this tab.")
		select {
		case codes <- query.Get("code"):
		default:
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	if opts.OpenURL != nil {
		opts.OpenURL(authorize)
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var code string
	select {
	case code = <-codes:
	case err := <-failures:
		return Token{}, err
	case <-waitCtx.Done():
		return Token{}, fmt.Errorf("x login timed out waiting for the browser")
	}
	client := &Client{
		clientID: clientID, clientSecret: strings.TrimSpace(opts.ClientSecret), tokenURL: firstNonEmpty(opts.TokenURL, DefaultTokenURL),
		http: opts.HTTPClient, now: time.Now,
	}
	if client.http == nil {
		client.http = &http.Client{Timeout: 60 * time.Second}
	}
	token, err := client.exchange(ctx, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirect},
		"code_verifier": {verifier},
		"client_id":     {clientID},
	})
	if err != nil {
		return Token{}, err
	}
	if token.RefreshToken == "" {
		return Token{}, fmt.Errorf("x returned no refresh token; the app must request offline.access")
	}
	token.Seed = token.RefreshToken
	return token, nil
}

func randomString(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

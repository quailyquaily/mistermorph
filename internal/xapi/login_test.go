package xapi

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func TestLogin(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "the-code" || r.Form.Get("code_verifier") == "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_request"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"refresh","expires_in":7200}`))
	})
	mux.HandleFunc("/2/users/me", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"id":"42","name":"Agent","username":"agent_bot"}}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	redirect := fmt.Sprintf("http://127.0.0.1:%d/x/callback", freePort(t))
	session, err := StartLogin(LoginOptions{ClientID: "client", RedirectURL: redirect, BaseURL: server.URL + "/2", TokenURL: server.URL + "/oauth2/token"})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if _, err := session.Result(); err != ErrLoginPending {
		t.Fatalf("Result() before the browser came back = %v", err)
	}
	authorize, _ := url.Parse(session.AuthorizeURL)
	query := authorize.Query()
	if query.Get("redirect_uri") != redirect || query.Get("code_challenge_method") != "S256" || query.Get("scope") != Scopes {
		t.Fatalf("authorize url = %s", session.AuthorizeURL)
	}

	// A callback with the wrong state is refused and does not end the login.
	if resp, err := http.Get(redirect + "?state=forged&code=the-code"); err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("forged callback = %v, %v", resp, err)
	}
	// The browser comes back from X.
	if _, err := http.Get(redirect + "?state=" + url.QueryEscape(query.Get("state")) + "&code=the-code"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	token, err := session.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if token.RefreshToken != "refresh" || token.Seed != "refresh" || token.Username != "agent_bot" || token.UserID != "42" {
		t.Fatalf("token = %+v", token)
	}
}

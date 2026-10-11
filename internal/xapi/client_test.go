package xapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type memoryTokens struct {
	mu    sync.Mutex
	token Token
	ok    bool
}

func (m *memoryTokens) Load() (Token, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.token, m.ok
}

func (m *memoryTokens) Save(t Token) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token, m.ok = t, true
	return nil
}

func TestTokenRotation(t *testing.T) {
	var mu sync.Mutex
	refreshes := 0
	validAccess := ""
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		mu.Lock()
		defer mu.Unlock()
		want := "refresh-0"
		if refreshes > 0 {
			want = "refresh-" + string(rune('0'+refreshes))
		}
		if r.Form.Get("refresh_token") != want {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_request","error_description":"Value passed for the token was invalid."}`))
			return
		}
		refreshes++
		validAccess = "access-" + string(rune('0'+refreshes))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": validAccess, "refresh_token": "refresh-" + string(rune('0'+refreshes)), "expires_in": 7200,
		})
	})
	mux.HandleFunc("/2/users/me", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ok := r.Header.Get("Authorization") == "Bearer "+validAccess
		mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"title":"Unauthorized","detail":"Unauthorized","status":401}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":{"id":"42","name":"Agent","username":"agent"}}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	store := &memoryTokens{}
	newClient := func() *Client {
		client, err := NewClient(Options{
			ClientID: "client", RefreshToken: "refresh-0", Store: store,
			BaseURL: server.URL + "/2", TokenURL: server.URL + "/oauth2/token",
		})
		if err != nil {
			t.Fatal(err)
		}
		return client
	}
	ctx := context.Background()

	client := newClient()
	if me, err := client.Me(ctx); err != nil || me.ID != "42" {
		t.Fatalf("Me() = %+v, %v", me, err)
	}
	if store.token.RefreshToken != "refresh-1" || store.token.Seed != "refresh-0" {
		t.Fatalf("saved token = %+v, want the rotated refresh token with its seed", store.token)
	}

	// A restart with the same configured token uses the saved, rotated one.
	store.token.AccessToken = ""
	if _, err := newClient().Me(ctx); err != nil {
		t.Fatalf("Me() after restart = %v", err)
	}
	if refreshes != 2 || store.token.RefreshToken != "refresh-2" {
		t.Fatalf("refreshes = %d, saved = %+v", refreshes, store.token)
	}

	// An access token the server stopped accepting is renewed once.
	mu.Lock()
	validAccess = "revoked"
	mu.Unlock()
	client = newClient()
	client.token.ExpiresAt = time.Now().Add(time.Hour)
	if _, err := client.Me(ctx); err != nil {
		t.Fatalf("Me() with a revoked access token = %v", err)
	}
	if got := client.Usage().Counts[UsageUserReads]; got != 1 {
		t.Fatalf("user reads = %d, want 1", got)
	}
}

func TestRefusedRefreshToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_request","error_description":"Value passed for the token was invalid."}`))
	}))
	defer server.Close()
	client, err := NewClient(Options{ClientID: "client", RefreshToken: "stale", BaseURL: server.URL, TokenURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Me(context.Background()); !IsUnauthorized(err) {
		t.Fatalf("Me() = %v, want unauthorized", err)
	}
}

func TestWeight(t *testing.T) {
	cases := []struct {
		text string
		want int
	}{
		{"hello", 5},
		{"こんにちは", 10},
		{"see https://example.com/a/very/long/path/that/is/long", 4 + 23},
		{"héllo — ok", 10},
	}
	for _, tc := range cases {
		if got := Weight(tc.text); got != tc.want {
			t.Errorf("Weight(%q) = %d, want %d", tc.text, got, tc.want)
		}
	}
}

func TestSplitPosts(t *testing.T) {
	t.Run("short text is one post", func(t *testing.T) {
		if got := SplitPosts("hi there", 3); len(got) != 1 || got[0] != "hi there" {
			t.Fatalf("SplitPosts = %q", got)
		}
	})
	t.Run("every part fits and the cut is marked", func(t *testing.T) {
		text := strings.Repeat("漢字のテキスト。", 80)
		parts := SplitPosts(text, 3)
		if len(parts) != 3 {
			t.Fatalf("got %d parts, want 3", len(parts))
		}
		for _, part := range parts {
			if Weight(part) > MaxPostWeight {
				t.Fatalf("part weighs %d: %q", Weight(part), part)
			}
		}
		if !strings.HasSuffix(parts[2], "…") {
			t.Fatalf("last part %q does not show the cut", parts[2])
		}
	})
	t.Run("breaks at spaces", func(t *testing.T) {
		text := strings.Repeat("word ", 100)
		for _, part := range SplitPosts(text, 5) {
			if strings.HasSuffix(part, "wor") || strings.HasPrefix(part, "d") {
				t.Fatalf("a word was cut: %q", part)
			}
		}
	})
}

func TestStripLinks(t *testing.T) {
	got := StripLinks("Read https://example.com/x now.\nAlso http://a.b")
	if got != "Read now.\nAlso" {
		t.Fatalf("StripLinks = %q", got)
	}
}

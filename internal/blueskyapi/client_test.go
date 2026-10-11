package blueskyapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type memoryStore struct {
	mu      sync.Mutex
	session Session
	saved   int
}

func (m *memoryStore) Load() (Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.session, m.session.RefreshJWT != ""
}

func (m *memoryStore) Save(s Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.session = s
	m.saved++
	return nil
}

// fakePDS answers the calls the tests make, and records what it saw.
type fakePDS struct {
	mu       sync.Mutex
	logins   int
	refresh  int
	expired  bool
	proxies  map[string]string
	handlers map[string]http.HandlerFunc
}

func newFakePDS() *fakePDS {
	return &fakePDS{proxies: map[string]string{}, handlers: map[string]http.HandlerFunc{}}
}

func (f *fakePDS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	nsid := strings.TrimPrefix(r.URL.Path, "/xrpc/")
	f.mu.Lock()
	f.proxies[nsid] = r.Header.Get("atproto-proxy")
	f.mu.Unlock()
	switch nsid {
	case "com.atproto.server.createSession":
		f.mu.Lock()
		f.logins++
		f.mu.Unlock()
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["password"] != "app-pass" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"AuthenticationRequired","message":"Invalid identifier or password"}`))
			return
		}
		_, _ = w.Write([]byte(`{"did":"did:plc:agent","handle":"agent.bsky.social","accessJwt":"access-1","refreshJwt":"refresh-1"}`))
		return
	case "com.atproto.server.refreshSession":
		f.mu.Lock()
		f.refresh++
		f.expired = false
		f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer refresh-1" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"ExpiredToken"}`))
			return
		}
		_, _ = w.Write([]byte(`{"did":"did:plc:agent","handle":"agent.bsky.social","accessJwt":"access-2","refreshJwt":"refresh-1"}`))
		return
	}
	f.mu.Lock()
	expired := f.expired
	handler := f.handlers[nsid]
	f.mu.Unlock()
	if expired {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"ExpiredToken","message":"Token has expired"}`))
		return
	}
	if handler == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	handler(w, r)
}

func newTestClient(t *testing.T, pds *fakePDS, store SessionStore) *Client {
	t.Helper()
	server := httptest.NewServer(pds)
	t.Cleanup(server.Close)
	client, err := NewClient(Options{ServiceURL: server.URL, Identifier: "agent.bsky.social", AppPassword: "app-pass", Store: store})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestSession(t *testing.T) {
	ctx := context.Background()

	t.Run("logs in once and renews an expired token", func(t *testing.T) {
		pds := newFakePDS()
		pds.handlers["chat.bsky.convo.listConvos"] = func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"convos":[]}`))
		}
		store := &memoryStore{}
		client := newTestClient(t, pds, store)
		if _, _, err := client.ListConvos(ctx, "", true); err != nil {
			t.Fatal(err)
		}
		pds.mu.Lock()
		pds.expired = true
		pds.mu.Unlock()
		if _, _, err := client.ListConvos(ctx, "", true); err != nil {
			t.Fatalf("ListConvos() after expiry = %v", err)
		}
		if pds.logins != 1 || pds.refresh != 1 {
			t.Fatalf("logins = %d, refreshes = %d, want 1 and 1", pds.logins, pds.refresh)
		}
		if store.session.AccessJWT != "access-2" || client.DID() != "did:plc:agent" {
			t.Fatalf("saved session = %+v", store.session)
		}
		if got := pds.proxies["chat.bsky.convo.listConvos"]; got != ChatProxy {
			t.Fatalf("chat proxy header = %q, want %q", got, ChatProxy)
		}
	})

	t.Run("a saved session is reused without logging in", func(t *testing.T) {
		pds := newFakePDS()
		pds.handlers["app.bsky.notification.listNotifications"] = func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"notifications":[]}`))
		}
		store := &memoryStore{session: Session{DID: "did:plc:agent", Handle: "agent.bsky.social", AccessJWT: "access-1", RefreshJWT: "refresh-1"}}
		client := newTestClient(t, pds, store)
		if _, _, err := client.ListNotifications(ctx, []string{"mention"}, 10, ""); err != nil {
			t.Fatal(err)
		}
		if pds.logins != 0 {
			t.Fatalf("logins = %d, want 0", pds.logins)
		}
		if got := pds.proxies["app.bsky.notification.listNotifications"]; got != "" {
			t.Fatalf("a non-chat call carried proxy %q", got)
		}
	})

	t.Run("a refused password is reported as unauthorized", func(t *testing.T) {
		pds := newFakePDS()
		server := httptest.NewServer(pds)
		defer server.Close()
		client, err := NewClient(Options{ServiceURL: server.URL, Identifier: "agent.bsky.social", AppPassword: "wrong"})
		if err != nil {
			t.Fatal(err)
		}
		if err := client.Connect(ctx); !IsUnauthorized(err) {
			t.Fatalf("Connect() = %v, want unauthorized", err)
		}
	})
}

func TestFacets(t *testing.T) {
	pds := newFakePDS()
	pds.handlers["com.atproto.identity.resolveHandle"] = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("handle") == "alice.bsky.social" {
			_, _ = w.Write([]byte(`{"did":"did:plc:alice"}`))
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"InvalidRequest"}`))
	}
	client := newTestClient(t, pds, nil)
	text := "你好 @alice.bsky.social, see https://example.com/a. @nobody.example"
	facets := client.Facets(context.Background(), text)
	if len(facets) != 2 {
		t.Fatalf("facets = %+v, want a link and one mention", facets)
	}
	for _, facet := range facets {
		got := text[facet.Index.ByteStart:facet.Index.ByteEnd]
		switch facet.Features[0]["$type"] {
		case "app.bsky.richtext.facet#link":
			if got != "https://example.com/a" {
				t.Fatalf("link covers %q", got)
			}
		case "app.bsky.richtext.facet#mention":
			if got != "@alice.bsky.social" || facet.Features[0]["did"] != "did:plc:alice" {
				t.Fatalf("mention covers %q (%v)", got, facet.Features[0])
			}
		}
	}
}

func TestPeerID(t *testing.T) {
	for _, did := range []string{"did:plc:abc123", "did:web:example.com"} {
		peer := PeerID(did)
		if strings.Contains(peer, ":") || DIDFromPeer(peer) != did {
			t.Fatalf("PeerID(%q) = %q, back = %q", did, peer, DIDFromPeer(peer))
		}
	}
}

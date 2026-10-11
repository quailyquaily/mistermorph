package bluesky

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/blueskyapi"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/socialpost"
)

// fakeBluesky is a PDS with chat and notifications, for one agent and its correspondents.
type fakeBluesky struct {
	mu        sync.Mutex
	calls     map[string][]map[string]any
	responses map[string]string
}

func (f *fakeBluesky) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	nsid := strings.TrimPrefix(r.URL.Path, "/xrpc/")
	record := map[string]any{"query": r.URL.Query().Encode()}
	if r.Method == http.MethodPost {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		record["body"] = body
	}
	f.mu.Lock()
	f.calls[nsid] = append(f.calls[nsid], record)
	response, ok := f.responses[nsid]
	f.mu.Unlock()
	if nsid == "com.atproto.server.createSession" {
		response, ok = `{"did":"did:plc:agent","handle":"agent.test","accessJwt":"a","refreshJwt":"r"}`, true
	}
	if !ok {
		response = `{}`
	}
	_, _ = w.Write([]byte(response))
}

func (f *fakeBluesky) callsTo(nsid string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.calls[nsid]...)
}

func newFake(t *testing.T, responses map[string]string) (*fakeBluesky, *blueskyapi.Client) {
	t.Helper()
	fake := &fakeBluesky{calls: map[string][]map[string]any{}, responses: responses}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	client, err := blueskyapi.NewClient(blueskyapi.Options{ServiceURL: server.URL, Identifier: "agent.test", AppPassword: "pw"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	return fake, client
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newDMTransport(client *blueskyapi.Client, allowed ...string) *dmTransport {
	logger := discardLogger()
	return &dmTransport{
		client: client, logger: logger, now: time.Now, status: &statusTracker{logger: logger},
		poll: time.Second, allowed: toSet(allowed), convos: map[string]string{},
	}
}

func TestDMTransport(t *testing.T) {
	now := time.Now().UTC()
	at := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339Nano) }
	responses := map[string]string{
		"chat.bsky.convo.listConvos": `{"convos":[{"id":"c1","rev":"1","unreadCount":2,"muted":false,"status":"accepted",
			"members":[{"did":"did:plc:agent","handle":"agent.test"},{"did":"did:plc:alice","handle":"alice.test","displayName":"Alice"}]}]}`,
		"chat.bsky.convo.listConvoRequests": `{"requests":[{"id":"c2","rev":"1","unreadCount":1,"muted":false,"status":"request",
			"members":[{"did":"did:plc:agent","handle":"agent.test"},{"did":"did:plc:mallory","handle":"mallory.test"}]}]}`,
		"chat.bsky.convo.getMessages": `{"messages":[
			{"$type":"chat.bsky.convo.defs#messageView","id":"m2","rev":"0002","text":"second","sender":{"did":"did:plc:alice"},"sentAt":"` + at(-time.Minute) + `"},
			{"$type":"chat.bsky.convo.defs#messageView","id":"m0","rev":"0000","text":"mine","sender":{"did":"did:plc:agent"},"sentAt":"` + at(-3*time.Minute) + `"},
			{"$type":"chat.bsky.convo.defs#messageView","id":"m1","rev":"0001","text":"first","sender":{"did":"did:plc:alice"},"sentAt":"` + at(-2*time.Minute) + `"}]}`,
		"chat.bsky.convo.getConvoForMembers": `{"convo":{"id":"c9","rev":"1","unreadCount":0,"muted":false,"members":[]}}`,
		"chat.bsky.convo.sendMessage":        `{"id":"m9","rev":"9","text":"hi","sender":{"did":"did:plc:agent"},"sentAt":"` + at(0) + `"}`,
	}

	t.Run("delivers unread messages in order and marks them read; a request from outside the allowlist is left alone", func(t *testing.T) {
		fake, client := newFake(t, responses)
		transport := newDMTransport(client, blueskyapi.PeerID("did:plc:alice"))
		var got []accountdm.Inbound
		err := transport.pollOnce(context.Background(), now, func(_ context.Context, in accountdm.Inbound) error {
			got = append(got, in)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 || got[0].Text != "first" || got[1].Text != "second" {
			t.Fatalf("delivered = %+v", got)
		}
		if got[0].PeerID != "did.plc.alice" || got[0].AccountID != "did.plc.agent" || got[0].DisplayName != "Alice" {
			t.Fatalf("inbound = %+v", got[0])
		}
		reads := fake.callsTo("chat.bsky.convo.updateRead")
		if len(reads) != 1 || reads[0]["body"].(map[string]any)["messageId"] != "m2" {
			t.Fatalf("updateRead calls = %v", reads)
		}
		if accepts := fake.callsTo("chat.bsky.convo.acceptConvo"); len(accepts) != 0 {
			t.Fatalf("accepted a request from outside the allowlist: %v", accepts)
		}
	})

	t.Run("an unlisted bot is not answered", func(t *testing.T) {
		_, client := newFake(t, responses)
		transport := newDMTransport(client)
		bot := blueskyapi.ProfileBasic{DID: "did:plc:bot", Labels: []blueskyapi.Label{{Src: "did:plc:bot", Val: "bot"}}}
		if transport.admits(blueskyapi.PeerID(bot.DID), bot) {
			t.Fatal("an unlisted bot was admitted")
		}
	})

	t.Run("sending to someone new opens the conversation", func(t *testing.T) {
		fake, client := newFake(t, responses)
		transport := newDMTransport(client)
		if err := transport.SendText(context.Background(), "", "did.plc.bob", "hi", ""); err != nil {
			t.Fatal(err)
		}
		opens := fake.callsTo("chat.bsky.convo.getConvoForMembers")
		if len(opens) != 1 || !strings.Contains(opens[0]["query"].(string), "did%3Aplc%3Abob") {
			t.Fatalf("getConvoForMembers calls = %v", opens)
		}
		sends := fake.callsTo("chat.bsky.convo.sendMessage")
		if len(sends) != 1 || sends[0]["body"].(map[string]any)["convoId"] != "c9" {
			t.Fatalf("sendMessage calls = %v", sends)
		}
	})
}

func TestPostSource(t *testing.T) {
	now := time.Now().UTC()
	responses := map[string]string{
		"app.bsky.notification.listNotifications": `{"notifications":[
			{"uri":"at://did:plc:alice/app.bsky.feed.post/2","cid":"cid2","reason":"reply","isRead":false,"indexedAt":"` + now.Format(time.RFC3339Nano) + `",
			 "author":{"did":"did:plc:alice","handle":"alice.test","displayName":"Alice"},
			 "record":{"text":"@agent.test what about this?","createdAt":"` + now.Format(time.RFC3339Nano) + `",
			   "reply":{"root":{"uri":"at://did:plc:carol/app.bsky.feed.post/1","cid":"cid1"},"parent":{"uri":"at://did:plc:carol/app.bsky.feed.post/1","cid":"cid1"}}}},
			{"uri":"at://did:plc:bob/app.bsky.feed.post/3","cid":"cid3","reason":"mention","isRead":true,"indexedAt":"` + now.Format(time.RFC3339Nano) + `",
			 "author":{"did":"did:plc:bob","handle":"bob.test"},"record":{"text":"old","createdAt":"` + now.Format(time.RFC3339Nano) + `"}}]}`,
		"com.atproto.repo.createRecord": `{"uri":"at://did:plc:agent/app.bsky.feed.post/new","cid":"cidnew"}`,
	}
	fake, client := newFake(t, responses)
	logger := discardLogger()
	source := &postSource{client: client, logger: logger, now: time.Now, status: &statusTracker{logger: logger}, poll: time.Second}

	var posts []socialpost.Post
	if err := source.pollOnce(context.Background(), now, func(_ context.Context, p socialpost.Post) error {
		posts = append(posts, p)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(posts) != 1 {
		t.Fatalf("delivered %d posts, want only the unread one", len(posts))
	}
	got := posts[0]
	if got.ThreadID != "at://did:plc:carol/app.bsky.feed.post/1" || got.AuthorID != "did.plc.alice" || got.AuthorHandle != "alice.test" {
		t.Fatalf("post = %+v", got)
	}
	if seen := fake.callsTo("app.bsky.notification.updateSeen"); len(seen) != 1 {
		t.Fatalf("updateSeen calls = %d, want 1", len(seen))
	}

	if err := source.Reply(context.Background(), got, []string{"one", "two"}); err != nil {
		t.Fatal(err)
	}
	creates := fake.callsTo("com.atproto.repo.createRecord")
	if len(creates) != 2 {
		t.Fatalf("createRecord calls = %d, want 2", len(creates))
	}
	reply := func(i int) map[string]any {
		return creates[i]["body"].(map[string]any)["record"].(map[string]any)["reply"].(map[string]any)
	}
	uri := func(ref any) string { return ref.(map[string]any)["uri"].(string) }
	if uri(reply(0)["root"]) != "at://did:plc:carol/app.bsky.feed.post/1" || uri(reply(0)["parent"]) != got.ID {
		t.Fatalf("first reply refs = %v", reply(0))
	}
	if uri(reply(1)["parent"]) != "at://did:plc:agent/app.bsky.feed.post/new" {
		t.Fatalf("second reply does not follow the first: %v", reply(1))
	}
}

func TestSplitPosts(t *testing.T) {
	text := strings.Repeat("word ", 200)
	parts := splitPosts(text, blueskyapi.MaxPostGraphemes, 2)
	if len(parts) != 2 || !strings.HasSuffix(parts[1], "…") {
		t.Fatalf("parts = %d, last = %q", len(parts), parts[len(parts)-1])
	}
	for _, part := range parts {
		if n := len([]rune(part)); n > blueskyapi.MaxPostGraphemes {
			t.Fatalf("part has %d characters", n)
		}
	}
}

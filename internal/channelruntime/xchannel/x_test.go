package xchannel

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/socialpost"
	"github.com/quailyquaily/mistermorph/internal/xapi"
)

// fakeX serves the X API calls the channel makes; responses are set per path.
type fakeX struct {
	mu        sync.Mutex
	responses map[string]string
	calls     map[string][]string
	posted    []map[string]any
	nextID    int
}

func (f *fakeX) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path == "/oauth2/token" {
		_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"refresh-next","expires_in":7200}`))
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/2")
	f.calls[path] = append(f.calls[path], r.URL.RawQuery)
	if r.Method == http.MethodPost && path == "/tweets" {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.posted = append(f.posted, body)
		f.nextID++
		_, _ = w.Write([]byte(`{"data":{"id":"90` + string(rune('0'+f.nextID)) + `"}}`))
		return
	}
	if response, ok := f.responses[path]; ok {
		_, _ = w.Write([]byte(response))
		return
	}
	_, _ = w.Write([]byte(`{}`))
}

func (f *fakeX) set(path, response string) {
	f.mu.Lock()
	f.responses[path] = response
	f.mu.Unlock()
}

func newFake(t *testing.T) (*fakeX, *xapi.Client) {
	t.Helper()
	fake := &fakeX{responses: map[string]string{}, calls: map[string][]string{}}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	client, err := xapi.NewClient(xapi.Options{ClientID: "id", RefreshToken: "refresh", BaseURL: server.URL + "/2", TokenURL: server.URL + "/oauth2/token"})
	if err != nil {
		t.Fatal(err)
	}
	return fake, client
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

var me = xapi.User{ID: "1000", Username: "agent", Name: "Agent"}

func TestDMTransport(t *testing.T) {
	fake, client := newFake(t)
	now := time.Now().UTC()
	at := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339Nano) }
	fake.set("/dm_events", `{"data":[
		{"id":"1500","event_type":"MessageCreate","text":"my reply","sender_id":"1000","created_at":"`+at(-time.Second)+`"},
		{"id":"1400","event_type":"MessageCreate","text":"second","sender_id":"2000","created_at":"`+at(-time.Minute)+`"},
		{"id":"1300","event_type":"MessageCreate","text":"hello","sender_id":"3000","created_at":"`+at(-2*time.Minute)+`"},
		{"id":"999","event_type":"MessageCreate","text":"first","sender_id":"2000","created_at":"`+at(-3*time.Minute)+`"}],
		"includes":{"users":[{"id":"2000","name":"Alice","username":"alice"}]}}`)
	logger := discardLogger()
	transport := &dmTransport{
		client: client, me: me, logger: logger, now: time.Now, status: &statusTracker{logger: logger},
		state: newState(filepath.Join(t.TempDir(), "state.json")), poll: time.Second, allowed: toSet([]string{"2000"}),
	}
	var got []accountdm.Inbound
	deliver := func(_ context.Context, in accountdm.Inbound) error {
		got = append(got, in)
		return nil
	}

	t.Run("delivers others' messages oldest first, from the allowlist", func(t *testing.T) {
		if err := transport.pollOnce(context.Background(), now, deliver); err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 || got[0].Text != "first" || got[1].Text != "second" || got[0].DisplayName != "Alice" {
			t.Fatalf("delivered = %+v", got)
		}
	})

	t.Run("the next poll skips what it saw", func(t *testing.T) {
		got = nil
		if err := transport.pollOnce(context.Background(), now, deliver); err != nil {
			t.Fatal(err)
		}
		if len(got) != 0 {
			t.Fatalf("delivered again: %+v", got)
		}
	})

	t.Run("messages only people who wrote first", func(t *testing.T) {
		if err := transport.SendText(context.Background(), "", "3000", "hi", ""); err != nil {
			t.Fatalf("SendText to someone who wrote = %v", err)
		}
		if err := transport.SendText(context.Background(), "", "4000", "hi", ""); err == nil || !strings.Contains(err.Error(), "wrote first") {
			t.Fatalf("SendText to a stranger = %v, want refused", err)
		}
	})
}

func TestPostSource(t *testing.T) {
	fake, client := newFake(t)
	logger := discardLogger()
	source := &postSource{
		client: client, me: me, logger: logger, now: time.Now, status: &statusTracker{logger: logger},
		state: newState(filepath.Join(t.TempDir(), "state.json")), poll: time.Second,
	}
	mentions := `{"data":[
		{"id":"5002","text":"@agent and this?","author_id":"2000","conversation_id":"5000","referenced_tweets":[{"type":"replied_to","id":"5001"}]},
		{"id":"5001","text":"@agent what?","author_id":"2000","conversation_id":"5000"}],
		"includes":{"users":[{"id":"2000","name":"Alice","username":"alice"}]},"meta":{"newest_id":"5002"}}`
	fake.set("/users/1000/mentions", mentions)
	var got []socialpost.Post
	deliver := func(_ context.Context, p socialpost.Post) error {
		got = append(got, p)
		return nil
	}

	t.Run("the first poll only records where to start", func(t *testing.T) {
		if err := source.pollOnce(context.Background(), deliver); err != nil {
			t.Fatal(err)
		}
		if len(got) != 0 || source.state.read().MentionsSinceID != "5002" {
			t.Fatalf("delivered %d, since = %q", len(got), source.state.read().MentionsSinceID)
		}
	})

	t.Run("later polls deliver new mentions oldest first, from since_id", func(t *testing.T) {
		if err := source.pollOnce(context.Background(), deliver); err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 || got[0].ID != "5001" || got[1].ThreadID != "5000" || got[1].AuthorHandle != "alice" {
			t.Fatalf("delivered = %+v", got)
		}
		calls := fake.calls["/users/1000/mentions"]
		if !strings.Contains(calls[len(calls)-1], "since_id=5002") {
			t.Fatalf("mentions query = %q", calls[len(calls)-1])
		}
	})

	t.Run("replies chain, without links", func(t *testing.T) {
		parts := source.Split("See https://example.com for more.", 3)
		if len(parts) != 1 || strings.Contains(parts[0], "http") {
			t.Fatalf("parts = %q", parts)
		}
		if err := source.Reply(context.Background(), got[1], []string{"one", "two"}); err != nil {
			t.Fatal(err)
		}
		inReplyTo := func(i int) string {
			return fake.posted[i]["reply"].(map[string]any)["in_reply_to_tweet_id"].(string)
		}
		if len(fake.posted) != 2 || inReplyTo(0) != "5002" || inReplyTo(1) != "901" {
			t.Fatalf("posted = %v", fake.posted)
		}
	})
}

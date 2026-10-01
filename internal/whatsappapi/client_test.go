package whatsappapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu    sync.Mutex
	now   time.Time
	slept []time.Duration
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Sleep(_ context.Context, d time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.slept = append(c.slept, d)
	c.now = c.now.Add(d)
	return nil
}

func newTestClient(t *testing.T, handler http.HandlerFunc) (*Client, *fakeClock) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	clock := &fakeClock{now: time.Unix(1790000000, 0)}
	client, err := NewClient("tok", Options{BaseURL: server.URL, HTTPClient: server.Client(), Now: clock.Now, Sleep: clock.Sleep})
	if err != nil {
		t.Fatal(err)
	}
	return client, clock
}

func TestGetUpdatesReadsMessagesAndKeepsTheOffsetOn204(t *testing.T) {
	calls := 0
	client, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer tok" || r.URL.Path != "/updates" {
			t.Errorf("request = %s %v", r.URL, r.Header)
		}
		if calls == 2 {
			if r.URL.Query().Get("offset") != "9223372036854775806" {
				t.Errorf("offset = %s", r.URL.Query().Get("offset"))
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Query().Get("offset") != "0" || r.URL.Query().Get("timeout") != "25" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		_, _ = io.WriteString(w, `{"object":"whatsapp_agent_platform","entry":[{"id":"123","changes":[{"field":"messages","value":{
			"messaging_product":"whatsapp",
			"contacts":[{"wa_id":"user:509","profile":{"name":"Alex"}}],
			"messages":[{"from":"user:509","id":"wamid.A","timestamp":"1790000000","type":"text","text":{"body":"hi"},"context":{"id":"wamid.Z","from":"agent:123"}}],
			"statuses":[{"id":"wamid.Q","status":"read","recipient_id":"user:509","timestamp":"1790000001"}]}}]}],
			"next_offset":9223372036854775806}`)
	})
	updates, err := client.GetUpdates(context.Background(), 0, 50, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if updates.AgentID != "123" || updates.NextOffset != 9223372036854775806 || len(updates.Messages) != 1 || len(updates.Statuses) != 1 {
		t.Fatalf("updates = %+v", updates)
	}
	msg := updates.Messages[0]
	if msg.Text.Body != "hi" || msg.Context.From != "agent:123" || msg.SentAt().Unix() != 1790000000 || updates.Contacts[0].Name != "Alex" {
		t.Fatalf("message = %+v", msg)
	}
	empty, err := client.GetUpdates(context.Background(), updates.NextOffset, 50, time.Second)
	if err != nil || !empty.Empty || empty.NextOffset != updates.NextOffset {
		t.Fatalf("204 = %+v, %v", empty, err)
	}
}

func TestAReplacedPollIsReported(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":{"code":1752041,"message":"replaced"}}`)
	})
	if _, err := client.GetUpdates(context.Background(), 0, 0, 0); !errors.Is(err, ErrPollReplaced) {
		t.Fatalf("err = %v", err)
	}
}

func TestSendTextQuotesAndSpacesSends(t *testing.T) {
	var bodies []map[string]any
	client, clock := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		_, _ = io.WriteString(w, `{"messaging_product":"whatsapp","messages":[{"id":"wamid.OUT"}]}`)
	})
	for i := 0; i < sendsPerMinute+1; i++ {
		id, err := client.SendText(context.Background(), "509", "hello", "wamid.IN")
		if err != nil || id != "wamid.OUT" {
			t.Fatalf("SendText = %q, %v", id, err)
		}
	}
	first := bodies[0]
	if first["to"] != "user:509" || first["type"] != "text" || first["messaging_product"] != "whatsapp" ||
		first["text"].(map[string]any)["body"] != "hello" || first["context"].(map[string]any)["message_id"] != "wamid.IN" {
		t.Fatalf("body = %v", first)
	}
	if len(clock.slept) != 1 || clock.slept[0] != time.Minute {
		t.Fatalf("the 13th send was not held back a minute: %v", clock.slept)
	}
}

func TestSendErrorsSayWhetherToRetry(t *testing.T) {
	for name, tc := range map[string]struct {
		status    int
		body      string
		retryable bool
		unknown   bool
		unauth    bool
	}{
		"rate limited":    {429, `{"error":{"code":130429}}`, true, false, false},
		"not accepted":    {503, `{"error":{"code":131016}}`, true, false, false},
		"server error":    {500, `{"error":{"code":2}}`, false, true, false},
		"not the creator": {403, `{"error":{"code":10,"error_data":{"details":"recipient is not the creator"}}}`, false, false, false},
		"bad token":       {401, `{"error":{"code":190}}`, false, false, true},
	} {
		t.Run(name, func(t *testing.T) {
			client, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})
			_, err := client.SendText(context.Background(), "509", "hi", "")
			if err == nil || IsRetryable(err) != tc.retryable || errors.Is(err, ErrSendUnknown) != tc.unknown || IsUnauthorized(err) != tc.unauth {
				t.Fatalf("err = %v retryable=%v unknown=%v unauth=%v", err, IsRetryable(err), errors.Is(err, ErrSendUnknown), IsUnauthorized(err))
			}
		})
	}
}

func TestParticipants(t *testing.T) {
	if UserID("user:509") != "509" || UserID("agent:1") != "" || UserID("509") != "" || UserID("user:") != "" || Participant("509") != "user:509" {
		t.Fatal("participant conversion")
	}
}

package discordapi

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock advances only when the client sleeps, so rate-limit waits are checked without waiting.
type fakeClock struct {
	mu    sync.Mutex
	now   time.Time
	slept []time.Duration
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)}
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

func (c *fakeClock) total() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	var sum time.Duration
	for _, d := range c.slept {
		sum += d
	}
	return sum
}

func newTestClient(t *testing.T, handler http.HandlerFunc) (*Client, *fakeClock, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	clock := newFakeClock()
	client, err := NewClient("bot-token", ClientOptions{BaseURL: server.URL + "/api/v10", HTTPClient: server.Client(), Now: clock.Now, Sleep: clock.Sleep})
	if err != nil {
		t.Fatal(err)
	}
	return client, clock, server
}

func TestClientSendsTheBotTokenAndDecodesTheUser(t *testing.T) {
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v10/users/@me" || r.Header.Get("Authorization") != "Bot bot-token" || !strings.HasPrefix(r.Header.Get("User-Agent"), "DiscordBot ") {
			t.Errorf("request = %s %s auth=%q ua=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("User-Agent"))
		}
		_, _ = io.WriteString(w, `{"id":"42","username":"morph","global_name":"Morph","avatar":"abc","bot":true}`)
	})
	user, err := client.Me(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if user.ID != "42" || user.DisplayName() != "Morph" || !user.Bot || user.AvatarURL() != "https://cdn.discordapp.com/avatars/42/abc.png" {
		t.Fatalf("user = %+v", user)
	}
}

func TestCreateMessagePingsNobodyAndReplies(t *testing.T) {
	var body map[string]any
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v10/channels/100/messages" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = io.WriteString(w, `{"id":"7","channel_id":"100","content":"hi"}`)
	})
	no := false
	sent, err := client.CreateMessage(context.Background(), "100", MessageCreate{
		Content:          "hi @everyone",
		AllowedMentions:  NoMentions(),
		MessageReference: &MessageReference{MessageID: "5", FailIfNotExists: &no},
	})
	if err != nil || sent.ID != "7" {
		t.Fatalf("CreateMessage = %+v, %v", sent, err)
	}
	mentions, _ := body["allowed_mentions"].(map[string]any)
	if parse, ok := mentions["parse"].([]any); !ok || len(parse) != 0 || mentions["replied_user"] != false {
		t.Fatalf("allowed_mentions = %v, want nobody pinged", body["allowed_mentions"])
	}
	if ref, _ := body["message_reference"].(map[string]any); ref["message_id"] != "5" || ref["fail_if_not_exists"] != false {
		t.Fatalf("message_reference = %v", body["message_reference"])
	}
}

func TestCreateMessageUploadsFiles(t *testing.T) {
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "multipart/form-data" {
			t.Errorf("content type = %q", r.Header.Get("Content-Type"))
			return
		}
		reader := multipart.NewReader(r.Body, params["boundary"])
		parts := map[string]string{}
		names := map[string]string{}
		for {
			part, err := reader.NextPart()
			if err != nil {
				break
			}
			data, _ := io.ReadAll(part)
			parts[part.FormName()] = string(data)
			names[part.FormName()] = part.FileName()
		}
		if !strings.Contains(parts["payload_json"], `"content":"the report"`) || parts["files[0]"] != "PDF!" || names["files[0]"] != "report.pdf" {
			t.Errorf("parts = %v, names = %v", parts, names)
		}
		_, _ = io.WriteString(w, `{"id":"8","channel_id":"100"}`)
	})
	_, err := client.CreateMessage(context.Background(), "100", MessageCreate{
		Content: "the report",
		Files:   []File{{Name: "report.pdf", ContentType: "application/pdf", Data: []byte("PDF!")}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCreateMessageRefusesTooLongContentAndBadIDs(t *testing.T) {
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s", r.URL.Path)
	})
	if _, err := client.CreateMessage(context.Background(), "100", MessageCreate{Content: strings.Repeat("字", MaxMessageLength+1)}); err == nil {
		t.Fatal("a message over 2000 characters was sent")
	}
	if _, err := client.CreateMessage(context.Background(), "../users", MessageCreate{Content: "x"}); err == nil {
		t.Fatal("a non-numeric channel id was accepted")
	}
}

func TestRateLimitHeadersMakeTheNextRequestWait(t *testing.T) {
	client, clock, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset-After", "2.5")
		_, _ = io.WriteString(w, `{}`)
	})
	for i := 0; i < 2; i++ {
		if err := client.TriggerTyping(context.Background(), "100"); err != nil {
			t.Fatal(err)
		}
	}
	if got := clock.total(); got != 2500*time.Millisecond {
		t.Fatalf("waited %v, want 2.5s before the second request", got)
	}
	// Another channel has its own limit.
	before := clock.total()
	if err := client.TriggerTyping(context.Background(), "200"); err != nil {
		t.Fatal(err)
	}
	if clock.total() != before {
		t.Fatal("a different channel waited on the first channel's limit")
	}
}

func TestTooManyRequestsIsRetriedAfterRetryAfter(t *testing.T) {
	calls := 0
	client, clock, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"message":"You are being rate limited.","retry_after":1.5,"global":false}`)
			return
		}
		_, _ = io.WriteString(w, `{"id":"9"}`)
	})
	sent, err := client.CreateMessage(context.Background(), "100", MessageCreate{Content: "x"})
	if err != nil || sent.ID != "9" || calls != 2 {
		t.Fatalf("CreateMessage = %+v, %v after %d calls", sent, err, calls)
	}
	if got := clock.total(); got != 1500*time.Millisecond {
		t.Fatalf("waited %v, want 1.5s", got)
	}
}

func TestGlobalRateLimitPausesEveryRoute(t *testing.T) {
	calls := 0
	client, clock, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("X-RateLimit-Global", "true")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"retry_after":3,"global":true}`)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	})
	if err := client.TriggerTyping(context.Background(), "100"); err != nil {
		t.Fatal(err)
	}
	if got := clock.total(); got != 3*time.Second {
		t.Fatalf("waited %v, want 3s", got)
	}
}

func TestErrorsAreDecodedAndNotRetried(t *testing.T) {
	calls := 0
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path == "/api/v10/users/@me" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"message":"401: Unauthorized","code":0}`)
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"message":"Missing Permissions","code":50013}`)
	})
	_, err := client.CreateMessage(context.Background(), "100", MessageCreate{Content: "x"})
	if ErrorCode(err) != ErrorCodeMissingPermission || calls != 1 || !strings.Contains(err.Error(), "Missing Permissions") {
		t.Fatalf("err = %v after %d calls", err, calls)
	}
	if _, err := client.Me(context.Background()); !IsUnauthorized(err) {
		t.Fatalf("Me err = %v, want unauthorized", err)
	}
}

func TestServerErrorsAreRetried(t *testing.T) {
	calls := 0
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = io.WriteString(w, `{"id":"1","type":1}`)
	})
	channel, err := client.CreateDM(context.Background(), "55")
	if err != nil || channel.ID != "1" || calls != 3 {
		t.Fatalf("CreateDM = %+v, %v after %d calls", channel, err, calls)
	}
}

func TestInteractionCallbackCarriesNoBotToken(t *testing.T) {
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v10/interactions/11/tok-en/callback" || r.Header.Get("Authorization") != "" {
			t.Errorf("request = %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != float64(InteractionResponseUpdateMessage) {
			t.Errorf("body = %v", body)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	content := "Approved"
	if err := client.RespondInteraction(context.Background(), "11", "tok-en", InteractionResponse{Type: InteractionResponseUpdateMessage, Data: &InteractionResponseData{Content: &content}}); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadAttachmentOnlyFromTheCDNAndWithoutTheToken(t *testing.T) {
	cdn := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("the bot token was sent to the CDN")
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = io.WriteString(w, "PNGDATA")
	}))
	defer cdn.Close()
	host, _ := url.Parse(cdn.URL)
	client, err := NewClient("bot-token", ClientOptions{HTTPClient: cdn.Client(), CDNHosts: []string{host.Hostname()}})
	if err != nil {
		t.Fatal(err)
	}
	data, contentType, err := client.DownloadAttachment(context.Background(), cdn.URL+"/attachments/1/2/a.png?ex=1", 100)
	if err != nil || string(data) != "PNGDATA" || contentType != "image/png" {
		t.Fatalf("DownloadAttachment = %q, %q, %v", data, contentType, err)
	}
	if _, _, err := client.DownloadAttachment(context.Background(), cdn.URL+"/a.png", 3); err == nil {
		t.Fatal("an attachment over the size limit was read")
	}
	if _, _, err := client.DownloadAttachment(context.Background(), "https://evil.example/a.png", 100); err == nil {
		t.Fatal("an attachment off the CDN was fetched")
	}
}

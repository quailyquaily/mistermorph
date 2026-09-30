package contactsruntime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
)

func TestResolveDiscordTarget(t *testing.T) {
	cases := []struct {
		name    string
		contact contacts.Contact
		hint    string
		want    discordSendTarget
		wantErr bool
	}{
		{name: "dm channel first", contact: contacts.Contact{DiscordUserID: "42", DiscordDMChannelID: "900", DiscordChannelIDs: []string{"200"}}, want: discordSendTarget{UserID: "42", ChannelID: "900"}},
		{name: "user opens a dm", contact: contacts.Contact{DiscordUserID: "42", DiscordChannelIDs: []string{"200"}}, want: discordSendTarget{UserID: "42"}},
		{name: "user from contact id", contact: contacts.Contact{ContactID: "discord_user:42"}, want: discordSendTarget{UserID: "42"}},
		{name: "channel only", contact: contacts.Contact{ContactID: "discord:200", DiscordChannelIDs: []string{"200"}}, want: discordSendTarget{ChannelID: "200"}},
		{name: "hint of a known channel", contact: contacts.Contact{DiscordUserID: "42", DiscordChannelIDs: []string{"200"}}, hint: "discord:200", want: discordSendTarget{ChannelID: "200"}},
		{name: "hint of an unknown channel", contact: contacts.Contact{DiscordUserID: "42"}, hint: "discord:777", wantErr: true},
		{name: "invalid hint", contact: contacts.Contact{DiscordUserID: "42"}, hint: "discord:x", wantErr: true},
		{name: "nothing", contact: contacts.Contact{ContactID: "tg:1"}, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveDiscordTargetWithChatID(tc.contact, tc.hint)
			if (err != nil) != tc.wantErr || (!tc.wantErr && got != tc.want) {
				t.Fatalf("ResolveDiscordTargetWithChatID() = %+v, %v", got, err)
			}
		})
	}
}

func TestSendToDiscordUserOpensADMAndPingsNobody(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		paths = append(paths, r.Method+" "+r.URL.Path)
		bodies = append(bodies, body)
		mu.Unlock()
		switch r.URL.Path {
		case "/api/users/@me/channels":
			_, _ = w.Write([]byte(`{"id":"900","type":1}`))
		default:
			_, _ = w.Write([]byte(`{"id":"1","channel_id":"900"}`))
		}
	}))
	defer server.Close()
	sender, err := NewRoutingSender(context.Background(), SenderOptions{DiscordBotToken: "tok", DiscordBaseURL: server.URL + "/api"})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	envelope, _ := json.Marshal(map[string]any{"message_id": "m1", "text": strings.Repeat("x", 2500) + " @everyone", "sent_at": "2026-09-30T10:00:00Z", "session_id": uuid.Must(uuid.NewV7()).String()})
	accepted, _, err := sender.Send(context.Background(), contacts.Contact{ContactID: "discord_user:42", Channel: contacts.ChannelDiscord, DiscordUserID: "42"}, contacts.ShareDecision{
		ContactID: "discord_user:42", ContentType: "application/json", PayloadBase64: base64.RawURLEncoding.EncodeToString(envelope), IdempotencyKey: "manual:discord:1",
	})
	if err != nil || !accepted {
		t.Fatalf("Send() = %v, %v", accepted, err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"POST /api/users/@me/channels", "POST /api/channels/900/messages", "POST /api/channels/900/messages"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Fatalf("requests = %v, want %v", paths, want)
	}
	if bodies[0]["recipient_id"] != "42" {
		t.Fatalf("dm body = %v", bodies[0])
	}
	for _, body := range bodies[1:] {
		mentions, _ := body["allowed_mentions"].(map[string]any)
		if parse, ok := mentions["parse"].([]any); !ok || len(parse) != 0 {
			t.Fatalf("message pings someone: %v", body["allowed_mentions"])
		}
	}
}

func TestDiscordSenderNeedsAToken(t *testing.T) {
	sender, err := NewRoutingSender(context.Background(), SenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	_, _, err = sender.Send(context.Background(), contacts.Contact{DiscordUserID: "42", Channel: contacts.ChannelDiscord}, contacts.ShareDecision{IdempotencyKey: "k", PayloadBase64: "e30"})
	if err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("Send() error = %v", err)
	}
}

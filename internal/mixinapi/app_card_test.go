package mixinapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestUserDecodesBotAppID(t *testing.T) {
	for _, tt := range []struct {
		name, data, want string
	}{
		{"bot", `{"user_id":"bot","full_name":"Morph","app":{"app_id":"bot","capabilities":["ENCRYPTED"]}}`, "bot"},
		{"legacy bot", `{"user_id":"bot","full_name":"Morph","app_id":"bot"}`, "bot"},
		{"human", `{"user_id":"human","full_name":"Alice","app":null}`, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var user User
			if err := json.Unmarshal([]byte(tt.data), &user); err != nil {
				t.Fatal(err)
			}
			if user.AppID != tt.want || user.UserID == "" || user.FullName == "" {
				t.Fatalf("user = %#v, want app_id %q", user, tt.want)
			}
		})
	}
}

func TestClientSendsAppCardWithoutEncryption(t *testing.T) {
	credentials := testCredentials()
	now := time.Now()
	requestID := "5f02a273-cd18-4af3-a57b-f3224a3c3591"
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"app_id":"773e5e77-4107-45c2-b648-8fc722ed77f5","title":"Morph","description":"Open this bot.","action":"mixin://apps/773e5e77-4107-45c2-b648-8fc722ed77f5"}`))
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/messages" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		wantToken, err := signAuthenticationToken(credentials, http.MethodPost, "/messages", raw, now, requestID)
		if err != nil || r.Header.Get("Authorization") != "Bearer "+wantToken {
			t.Errorf("request signature does not match body: %v", err)
		}
		var messages []MessageRequest
		if err := json.Unmarshal(raw, &messages); err != nil {
			t.Error(err)
			return
		}
		if len(messages) != 1 || messages[0].Category != "APP_CARD" || messages[0].DataBase64 != payload {
			t.Errorf("messages = %#v", messages)
		}
		_, _ = io.WriteString(w, "{}")
	}))
	defer server.Close()
	client, err := NewClient(credentials, ClientOptions{
		BaseURL: server.URL, HTTPClient: server.Client(),
		Now: func() time.Time { return now }, NewRequestID: func() string { return requestID },
	})
	if err != nil {
		t.Fatal(err)
	}
	messages := []MessageRequest{{
		ConversationID: "8f7059b9-b1b2-4ed8-a99f-4ac2f07a9a34", RecipientID: "11111111-1111-4111-8111-111111111111",
		MessageID: "a4ec1e53-f147-439a-82cd-2e5e4a95a152", Category: " app_card ", DataBase64: payload,
	}}
	if err := client.SendMessages(context.Background(), messages); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || messages[0].Category != " app_card " {
		t.Fatalf("calls=%d original category=%q", calls.Load(), messages[0].Category)
	}
}

func TestClientRejectsMixedAppCardBatchBeforeSending(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "unexpected request", http.StatusBadRequest)
	}))
	defer server.Close()
	client, err := NewClient(testCredentials(), ClientOptions{BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	for _, categories := range [][]string{{"APP_CARD", MessageCategoryEncryptedText}, {MessageCategoryEncryptedText, "APP_CARD"}, {"APP_CARD", "PLAIN_TEXT"}} {
		t.Run(strings.Join(categories, "_"), func(t *testing.T) {
			messages := []MessageRequest{{Category: categories[0]}, {Category: categories[1]}}
			if err := client.SendMessages(context.Background(), messages); err == nil {
				t.Fatal("accepted mixed card batch")
			}
			if calls.Load() != 0 {
				t.Fatal("sent part of invalid batch")
			}
		})
	}
}

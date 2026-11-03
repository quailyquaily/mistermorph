package contactsruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	telegrambus "github.com/quailyquaily/mistermorph/internal/bus/adapters/telegram"
)

func TestSendTelegramTargetRendersMarkdown(t *testing.T) {
	tests := []struct {
		name       string
		rejectHTML bool
		wantCalls  int
		wantText   string
		wantMode   string
	}{
		{name: "html", wantCalls: 1, wantText: "<strong>0056</strong> pushed, see <code>review/</code>", wantMode: "HTML"},
		{name: "plain fallback", rejectHTML: true, wantCalls: 2, wantText: "**0056** pushed, see `review/`", wantMode: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var bodies []map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Errorf("decode body: %v", err)
				}
				bodies = append(bodies, body)
				if tc.rejectHTML && body["parse_mode"] == "HTML" {
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"ok":false,"description":"Bad Request: can't parse entities: unexpected end tag"}`))
					return
				}
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer server.Close()

			sender := &RoutingSender{telegramBotToken: "token", telegramClient: server.Client(), telegramBaseURL: server.URL}
			err := sender.sendTelegramTarget(context.Background(), telegrambus.DeliveryTarget{ChatID: 42}, "**0056** pushed, see `review/`", telegrambus.SendTextOptions{})
			if err != nil {
				t.Fatalf("sendTelegramTarget() error = %v", err)
			}
			if len(bodies) != tc.wantCalls {
				t.Fatalf("calls = %d, want %d", len(bodies), tc.wantCalls)
			}
			last := bodies[len(bodies)-1]
			if last["text"] != tc.wantText {
				t.Fatalf("text = %q, want %q", last["text"], tc.wantText)
			}
			mode, _ := last["parse_mode"].(string)
			if mode != tc.wantMode {
				t.Fatalf("parse_mode = %q, want %q", mode, tc.wantMode)
			}
		})
	}
}

package builtin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
)

func TestAgentSendToolUsesContactsSendParameters(t *testing.T) {
	contactsTool := NewContactsSendTool(ContactsSendToolOptions{Enabled: true})
	agentTool := NewAgentSendTool(ContactsSendToolOptions{Enabled: true})

	var contactsSchema, agentSchema map[string]any
	if err := json.Unmarshal([]byte(contactsTool.ParameterSchema()), &contactsSchema); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(agentTool.ParameterSchema()), &agentSchema); err != nil {
		t.Fatal(err)
	}
	// agent_send is contacts_send without the file parameters.
	contactsProps := contactsSchema["properties"].(map[string]any)
	delete(contactsProps, "path")
	delete(contactsProps, "filename")
	contactsRaw, _ := json.Marshal(contactsSchema)
	agentRaw, _ := json.Marshal(agentSchema)
	if string(agentRaw) != string(contactsRaw) {
		t.Fatalf("agent_send schema = %s, want %s", agentRaw, contactsRaw)
	}
}

func TestAgentSendToolOnlySendsToActiveAgents(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 17, 8, 0, 0, 0, time.UTC)
	contactsDir := filepath.Join(t.TempDir(), "contacts")
	svc := contacts.NewService(contacts.NewFileStore(contactsDir))
	for _, contact := range []contacts.Contact{
		{
			ContactID:      "contact:smith",
			Kind:           contacts.KindAgent,
			Channel:        contacts.ChannelTelegram,
			TGUsername:     "smith_bot",
			TGGroupChatIDs: []int64{-1001},
		},
		{
			ContactID:      "tg:@alice",
			Kind:           contacts.KindHuman,
			Channel:        contacts.ChannelTelegram,
			TGUsername:     "alice",
			TGGroupChatIDs: []int64{-1001},
		},
	} {
		if _, err := svc.UpsertContact(ctx, contact, now); err != nil {
			t.Fatalf("UpsertContact(%q) error = %v", contact.ContactID, err)
		}
	}

	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"result": map[string]any{"message_id": 1},
		})
	}))
	defer server.Close()

	tool := NewAgentSendTool(ContactsSendToolOptions{
		Enabled:          true,
		ContactsDir:      contactsDir,
		TelegramBotToken: "token",
		TelegramBaseURL:  server.URL,
	})

	_, err := tool.Execute(ctx, map[string]any{
		"contact_id":   "tg:@smith_bot,tg:@alice",
		"message_text": "continue",
	})
	if err == nil || !strings.Contains(err.Error(), "not an active Agent") {
		t.Fatalf("mixed recipient Execute() error = %v, want active Agent rejection", err)
	}
	if got := requestCount.Load(); got != 0 {
		t.Fatalf("mixed recipient request count = %d, want 0", got)
	}
	_, err = tool.Execute(ctx, map[string]any{
		"contact_id":   "tg:-1001",
		"message_text": "continue",
	})
	if err == nil || !strings.Contains(err.Error(), "not an active Agent") {
		t.Fatalf("raw chat target Execute() error = %v, want active Agent rejection", err)
	}
	if got := requestCount.Load(); got != 0 {
		t.Fatalf("raw chat target request count = %d, want 0", got)
	}

	if _, err := tool.Execute(ctx, map[string]any{
		"contact_id":   "tg:@smith_bot",
		"message_text": "continue",
	}); err != nil {
		t.Fatalf("active Agent Execute() error = %v", err)
	}
	if got := requestCount.Load(); got != 1 {
		t.Fatalf("active Agent request count = %d, want 1", got)
	}
}

func TestAgentSendCooldown(t *testing.T) {
	ctx := context.Background()
	setup := func(t *testing.T, ok bool) (string, *atomic.Int32, string) {
		t.Helper()
		contactsDir := filepath.Join(t.TempDir(), "contacts")
		svc := contacts.NewService(contacts.NewFileStore(contactsDir))
		if _, err := svc.UpsertContact(ctx, contacts.Contact{
			ContactID:      "contact:smith",
			Kind:           contacts.KindAgent,
			Channel:        contacts.ChannelTelegram,
			TGUsername:     "smith_bot",
			TGGroupChatIDs: []int64{-1001},
		}, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		var requests atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			w.Header().Set("Content-Type", "application/json")
			if !ok {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "description": "chat not found"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": map[string]any{"message_id": 1}})
		}))
		t.Cleanup(server.Close)
		return contactsDir, &requests, server.URL
	}
	options := func(contactsDir, baseURL string) ContactsSendToolOptions {
		return ContactsSendToolOptions{
			Enabled:           true,
			ContactsDir:       contactsDir,
			TelegramBotToken:  "token",
			TelegramBaseURL:   baseURL,
			AgentSendCooldown: time.Hour,
		}
	}
	params := map[string]any{"contact_id": "tg:@smith_bot", "message_text": "continue"}

	t.Run("a send starts the cooldown", func(t *testing.T) {
		contactsDir, requests, baseURL := setup(t, true)
		agentTool := NewAgentSendTool(options(contactsDir, baseURL))
		if _, err := agentTool.Execute(ctx, params); err != nil {
			t.Fatalf("first Execute() error = %v", err)
		}
		if _, err := agentTool.Execute(ctx, params); err == nil || !strings.Contains(err.Error(), "cooling down") {
			t.Fatalf("second Execute() error = %v, want cooldown rejection", err)
		}
		contactsTool := NewContactsSendTool(options(contactsDir, baseURL))
		if _, err := contactsTool.Execute(ctx, params); err == nil || !strings.Contains(err.Error(), "cooling down") {
			t.Fatalf("contacts_send Execute() error = %v, want cooldown rejection", err)
		}
		if got := requests.Load(); got != 1 {
			t.Fatalf("request count = %d, want 1", got)
		}
	})

	t.Run("a failed send does not", func(t *testing.T) {
		contactsDir, requests, baseURL := setup(t, false)
		agentTool := NewAgentSendTool(options(contactsDir, baseURL))
		_, _ = agentTool.Execute(ctx, params)
		_, _ = agentTool.Execute(ctx, params)
		if got := requests.Load(); got != 2 {
			t.Fatalf("request count = %d, want 2", got)
		}
		contact, ok, err := contacts.NewFileStore(contactsDir).GetContact(ctx, "contact:smith")
		if err != nil || !ok {
			t.Fatalf("GetContact() = %v, %v", ok, err)
		}
		if contact.CooldownUntil != nil {
			t.Fatalf("cooldown_until = %v, want none after failures", contact.CooldownUntil)
		}
	})
}

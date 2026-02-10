package contacts

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileStoreContactsReadWrite(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	store := NewFileStore(root)
	if err := store.Ensure(ctx); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}

	active := Contact{
		ContactID:        "maep:12D3KooWactive",
		Kind:             KindAgent,
		Status:           StatusActive,
		Channel:          ChannelMAEP,
		ContactNickname:  "Active Agent",
		MAEPNodeID:       "maep:12D3KooWactive",
		MAEPDialAddress:  "/ip4/127.0.0.1/tcp/4021/p2p/12D3KooWactive",
		TopicPreferences: []string{"ops", "alerts"},
	}
	inactive := Contact{
		ContactID:        "tg:1001",
		Kind:             KindHuman,
		Status:           StatusInactive,
		Channel:          ChannelTelegram,
		ContactNickname:  "Inactive Human",
		TGUsername:       "john",
		PrivateChatID:    1001,
		GroupChatIDs:     []int64{-10001},
		TopicPreferences: []string{"planning"},
	}
	if err := store.PutContact(ctx, active); err != nil {
		t.Fatalf("PutContact(active) error = %v", err)
	}
	if err := store.PutContact(ctx, inactive); err != nil {
		t.Fatalf("PutContact(inactive) error = %v", err)
	}

	activeList, err := store.ListContacts(ctx, StatusActive)
	if err != nil {
		t.Fatalf("ListContacts(active) error = %v", err)
	}
	if len(activeList) != 1 || activeList[0].ContactID != active.ContactID {
		t.Fatalf("active contacts mismatch: got=%v", activeList)
	}
	if activeList[0].MAEPDialAddress == "" {
		t.Fatalf("active contact maep_dial_address should be set")
	}

	inactiveList, err := store.ListContacts(ctx, StatusInactive)
	if err != nil {
		t.Fatalf("ListContacts(inactive) error = %v", err)
	}
	if len(inactiveList) != 1 || inactiveList[0].ContactID != inactive.ContactID {
		t.Fatalf("inactive contacts mismatch: got=%v", inactiveList)
	}
	if inactiveList[0].PrivateChatID != 1001 {
		t.Fatalf("inactive private_chat_id mismatch: got %d want 1001", inactiveList[0].PrivateChatID)
	}
}

func TestFileStoreBusRecordsRoundTrip(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	store := NewFileStore(root)
	if err := store.Ensure(ctx); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}

	now := time.Date(2026, 2, 8, 11, 0, 0, 0, time.UTC)
	if err := store.PutBusInboxRecord(ctx, BusInboxRecord{
		Channel:           ChannelTelegram,
		PlatformMessageID: "12345",
		ConversationKey:   "telegram:-1001",
		SeenAt:            now,
	}); err != nil {
		t.Fatalf("PutBusInboxRecord() error = %v", err)
	}
	inbox, ok, err := store.GetBusInboxRecord(ctx, ChannelTelegram, "12345")
	if err != nil {
		t.Fatalf("GetBusInboxRecord() error = %v", err)
	}
	if !ok {
		t.Fatalf("GetBusInboxRecord() expected ok=true")
	}
	if inbox.ConversationKey != "telegram:-1001" {
		t.Fatalf("conversation_key mismatch: got %q", inbox.ConversationKey)
	}

	lastAttemptAt := now.Add(1 * time.Minute)
	if err := store.PutBusOutboxRecord(ctx, BusOutboxRecord{
		Channel:        ChannelMAEP,
		IdempotencyKey: "manual:k1",
		ContactID:      "maep:a",
		PeerID:         "12D3KooWA",
		ItemID:         "item-1",
		Topic:          "share.proactive.v1",
		ContentType:    "text/plain",
		PayloadBase64:  "aGVsbG8",
		Status:         BusDeliveryStatusPending,
		Attempts:       1,
		CreatedAt:      now,
		UpdatedAt:      now,
		LastAttemptAt:  &lastAttemptAt,
	}); err != nil {
		t.Fatalf("PutBusOutboxRecord() error = %v", err)
	}
	outbox, ok, err := store.GetBusOutboxRecord(ctx, ChannelMAEP, "manual:k1")
	if err != nil {
		t.Fatalf("GetBusOutboxRecord() error = %v", err)
	}
	if !ok {
		t.Fatalf("GetBusOutboxRecord() expected ok=true")
	}
	if outbox.Status != BusDeliveryStatusPending {
		t.Fatalf("outbox status mismatch: got %q", outbox.Status)
	}
}

func TestFileStoreBusOutboxRejectsUnknownField(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	store := NewFileStore(root)
	if err := store.Ensure(ctx); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "bus_outbox.json"),
		[]byte("{\"version\":1,\"records\":[{\"channel\":\"maep\",\"idempotency_key\":\"k\",\"status\":\"sent\",\"attempts\":1,\"created_at\":\"2026-02-08T12:00:00Z\",\"updated_at\":\"2026-02-08T12:00:00Z\",\"sent_at\":\"2026-02-08T12:00:00Z\",\"unknown\":\"x\"}]}\n"),
		0o600,
	); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, _, err := store.GetBusOutboxRecord(ctx, ChannelMAEP, "k"); err == nil {
		t.Fatalf("GetBusOutboxRecord() expected decode error for unknown field")
	}
}

func TestFileStoreParsesProfileMarkdownTemplate(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	store := NewFileStore(root)
	if err := store.Ensure(ctx); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	activeBody := `---
created_at: "1970-01-01T00:00:00Z"
updated_at: "1970-01-01T00:00:00Z"
---

# Active Contacts

## Alice

` + "```yaml\n" + `contact_id: "tg:90001"
nickname: "Alice"
kind: "human"
channel: "telegram"
tg_username: "alice"
private_chat_id: "90001"
group_chat_ids:
  - "-100222"
topic_preferences:
  - "golang"
` + "```\n"
	inactiveBody := `---
created_at: "1970-01-01T00:00:00Z"
updated_at: "1970-01-01T00:00:00Z"
---

# Inactive Contacts

## Morph Node

` + "```yaml\n" + `contact_id: "maep:12D3KooWPeerX"
kind: "agent"
channel: "maep"
maep_node_id: "maep:12D3KooWPeerX"
maep_dial_address: "/ip4/127.0.0.1/tcp/4021/p2p/12D3KooWPeerX"
` + "```\n"
	if err := os.WriteFile(filepath.Join(root, "ACTIVE.md"), []byte(activeBody), 0o600); err != nil {
		t.Fatalf("WriteFile(ACTIVE.md) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "INACTIVE.md"), []byte(inactiveBody), 0o600); err != nil {
		t.Fatalf("WriteFile(INACTIVE.md) error = %v", err)
	}

	active, err := store.ListContacts(ctx, StatusActive)
	if err != nil {
		t.Fatalf("ListContacts(active) error = %v", err)
	}
	if len(active) != 1 {
		t.Fatalf("active contacts mismatch: got=%d want=1", len(active))
	}
	if active[0].ContactID != "tg:90001" || active[0].Kind != KindHuman {
		t.Fatalf("active contact mismatch: %#v", active[0])
	}
	if active[0].PrivateChatID != 90001 {
		t.Fatalf("active private chat id mismatch: %#v", active[0])
	}

	inactive, err := store.ListContacts(ctx, StatusInactive)
	if err != nil {
		t.Fatalf("ListContacts(inactive) error = %v", err)
	}
	if len(inactive) != 1 {
		t.Fatalf("inactive contacts mismatch: got=%d want=1", len(inactive))
	}
	if inactive[0].MAEPNodeID != "maep:12D3KooWPeerX" || inactive[0].Kind != KindAgent {
		t.Fatalf("inactive contact mismatch: %#v", inactive[0])
	}
	if inactive[0].MAEPDialAddress == "" {
		t.Fatalf("inactive contact maep_dial_address should be set")
	}
}

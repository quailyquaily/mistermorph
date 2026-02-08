package contacts

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileStoreContactsCandidatesAuditAndSessions(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	store := NewFileStore(root)
	if err := store.Ensure(ctx); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}

	now := time.Date(2026, 2, 7, 10, 0, 0, 0, time.UTC)
	active := Contact{
		ContactID:          "maep:peer-active",
		Kind:               KindAgent,
		Status:             StatusActive,
		PeerID:             "12D3KooWactive",
		TrustState:         "verified",
		UnderstandingDepth: 40,
		ReciprocityNorm:    0.6,
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	inactive := Contact{
		ContactID:          "ext:telegram:1001",
		Kind:               KindHuman,
		Status:             StatusInactive,
		SubjectID:          "ext:telegram:1001",
		UnderstandingDepth: 20,
		ReciprocityNorm:    0.3,
		CreatedAt:          now,
		UpdatedAt:          now,
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

	inactiveList, err := store.ListContacts(ctx, StatusInactive)
	if err != nil {
		t.Fatalf("ListContacts(inactive) error = %v", err)
	}
	if len(inactiveList) != 1 || inactiveList[0].ContactID != inactive.ContactID {
		t.Fatalf("inactive contacts mismatch: got=%v", inactiveList)
	}

	candidate := ShareCandidate{
		ItemID:        "cand-1",
		Topic:         "distributed-systems",
		ContentType:   "text/plain",
		PayloadBase64: "aGVsbG8",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := store.PutCandidate(ctx, candidate); err != nil {
		t.Fatalf("PutCandidate() error = %v", err)
	}
	candidates, err := store.ListCandidates(ctx)
	if err != nil {
		t.Fatalf("ListCandidates() error = %v", err)
	}
	if len(candidates) != 1 || candidates[0].ItemID != candidate.ItemID {
		t.Fatalf("candidates mismatch: got=%v", candidates)
	}

	session := SessionState{
		SessionID:            "sess-1",
		ContactID:            active.ContactID,
		SessionInterestLevel: 0.6,
		TurnCount:            1,
		StartedAt:            now,
		UpdatedAt:            now,
	}
	if err := store.PutSessionState(ctx, session); err != nil {
		t.Fatalf("PutSessionState() error = %v", err)
	}
	states, err := store.ListSessionStates(ctx)
	if err != nil {
		t.Fatalf("ListSessionStates() error = %v", err)
	}
	if len(states) != 1 || states[0].SessionID != session.SessionID {
		t.Fatalf("session states mismatch: got=%v", states)
	}

	event := AuditEvent{
		EventID:   "evt-1",
		TickID:    "tick-1",
		Action:    "proactive_share_tick_start",
		ContactID: active.ContactID,
		CreatedAt: now,
	}
	if err := store.AppendAuditEvent(ctx, event); err != nil {
		t.Fatalf("AppendAuditEvent() error = %v", err)
	}
	events, err := store.ListAuditEvents(ctx, "tick-1", active.ContactID, "", 10)
	if err != nil {
		t.Fatalf("ListAuditEvents() error = %v", err)
	}
	if len(events) != 1 || events[0].EventID != event.EventID {
		t.Fatalf("audit events mismatch: got=%v", events)
	}
}

func TestFileStoreLegacyDisplayNameMigratesToContactNickname(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	store := NewFileStore(root)
	if err := store.Ensure(ctx); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}

	now := time.Date(2026, 2, 7, 11, 0, 0, 0, time.UTC)
	legacy := Contact{
		ContactID:   "tg:@alice",
		Kind:        KindHuman,
		Status:      StatusActive,
		SubjectID:   "tg:@alice",
		DisplayName: "Alice Legacy",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := store.PutContact(ctx, legacy); err != nil {
		t.Fatalf("PutContact(legacy) error = %v", err)
	}

	got, ok, err := store.GetContact(ctx, "tg:@alice")
	if err != nil {
		t.Fatalf("GetContact() error = %v", err)
	}
	if !ok {
		t.Fatalf("GetContact() expected ok=true")
	}
	if got.ContactNickname != "Alice Legacy" {
		t.Fatalf("contact nickname mismatch: got %q want %q", got.ContactNickname, "Alice Legacy")
	}
	if got.DisplayName != "" {
		t.Fatalf("display_name should be normalized away, got %q", got.DisplayName)
	}
}

func TestFileStoreNormalizesChannelEndpoints(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	store := NewFileStore(root)
	if err := store.Ensure(ctx); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}

	now := time.Date(2026, 2, 8, 9, 0, 0, 0, time.UTC)
	oldSeen := now.Add(-1 * time.Hour)
	newSeen := now.Add(-10 * time.Minute)
	input := Contact{
		ContactID:          "tg:id:1001",
		Kind:               KindHuman,
		Status:             StatusActive,
		SubjectID:          "tg:id:1001",
		UnderstandingDepth: 20,
		ReciprocityNorm:    0.4,
		ChannelEndpoints: []ChannelEndpoint{
			{Channel: " TELEGRAM ", ChatID: 1001, ChatType: "PRIVATE", LastSeenAt: &oldSeen},
			{Channel: "telegram", Address: "1001", ChatID: 1001, ChatType: "private", LastSeenAt: &newSeen},
			{Channel: "maep", Address: "12D3KooWpeer", ChatID: 101, ChatType: "group"},
			{Channel: "", Address: "ignored"},
		},
	}
	if err := store.PutContact(ctx, input); err != nil {
		t.Fatalf("PutContact() error = %v", err)
	}

	got, ok, err := store.GetContact(ctx, "tg:id:1001")
	if err != nil {
		t.Fatalf("GetContact() error = %v", err)
	}
	if !ok {
		t.Fatalf("GetContact() expected ok=true")
	}
	if len(got.ChannelEndpoints) != 2 {
		t.Fatalf("channel_endpoints length mismatch: got %d want 2", len(got.ChannelEndpoints))
	}

	telegram := got.ChannelEndpoints[0]
	if telegram.Channel != ChannelTelegram {
		t.Fatalf("telegram endpoint channel mismatch: got %q", telegram.Channel)
	}
	if telegram.ChatID != 1001 {
		t.Fatalf("telegram endpoint chat_id mismatch: got %d want 1001", telegram.ChatID)
	}
	if telegram.ChatType != "private" {
		t.Fatalf("telegram endpoint chat_type mismatch: got %q want %q", telegram.ChatType, "private")
	}
	if telegram.Address != "1001" {
		t.Fatalf("telegram endpoint address mismatch: got %q want %q", telegram.Address, "1001")
	}
	if telegram.LastSeenAt == nil || !telegram.LastSeenAt.Equal(newSeen) {
		t.Fatalf("telegram endpoint last_seen_at mismatch: got %v want %v", telegram.LastSeenAt, newSeen)
	}

	maepEndpoint := got.ChannelEndpoints[1]
	if maepEndpoint.Channel != ChannelMAEP {
		t.Fatalf("maep endpoint channel mismatch: got %q want %q", maepEndpoint.Channel, ChannelMAEP)
	}
	if maepEndpoint.Address != "12D3KooWpeer" {
		t.Fatalf("maep endpoint address mismatch: got %q", maepEndpoint.Address)
	}
	if maepEndpoint.ChatID != 0 {
		t.Fatalf("maep endpoint chat_id should be 0, got %d", maepEndpoint.ChatID)
	}
	if maepEndpoint.ChatType != "" {
		t.Fatalf("maep endpoint chat_type should be empty, got %q", maepEndpoint.ChatType)
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

	sentAt := now.Add(2 * time.Minute)
	if err := store.PutBusDeliveryRecord(ctx, BusDeliveryRecord{
		Channel:        ChannelMAEP,
		IdempotencyKey: "manual:k1",
		Status:         BusDeliveryStatusSent,
		Attempts:       1,
		Accepted:       true,
		CreatedAt:      now,
		UpdatedAt:      sentAt,
		LastAttemptAt:  &lastAttemptAt,
		SentAt:         &sentAt,
	}); err != nil {
		t.Fatalf("PutBusDeliveryRecord() error = %v", err)
	}
	delivery, ok, err := store.GetBusDeliveryRecord(ctx, ChannelMAEP, "manual:k1")
	if err != nil {
		t.Fatalf("GetBusDeliveryRecord() error = %v", err)
	}
	if !ok {
		t.Fatalf("GetBusDeliveryRecord() expected ok=true")
	}
	if delivery.Status != BusDeliveryStatusSent || !delivery.Accepted {
		t.Fatalf("delivery mismatch: got status=%q accepted=%v", delivery.Status, delivery.Accepted)
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

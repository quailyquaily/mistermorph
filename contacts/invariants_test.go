package contacts

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"testing"
	"time"
)

type mockSender struct {
	accepted bool
	deduped  bool
	err      error
	calls    int
}

func (m *mockSender) Send(ctx context.Context, contact Contact, decision ShareDecision) (bool, bool, error) {
	_ = ctx
	_ = contact
	_ = decision
	m.calls++
	return m.accepted, m.deduped, m.err
}

func TestInvariantOutboxIdempotency(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	store := NewFileStore(root)
	svc := NewService(store)
	now := time.Date(2026, 2, 8, 21, 0, 0, 0, time.UTC)

	if _, err := svc.UpsertContact(ctx, Contact{
		ContactID:       "maep:12D3KooWInv",
		Kind:            KindAgent,
		Status:          StatusActive,
		Channel:         ChannelMAEP,
		MAEPNodeID:      "maep:12D3KooWInv",
		MAEPDialAddress: "/ip4/127.0.0.1/tcp/4021/p2p/12D3KooWInv",
	}, now); err != nil {
		t.Fatalf("UpsertContact() error = %v", err)
	}

	sender := &mockSender{accepted: true}
	payload := base64.RawURLEncoding.EncodeToString([]byte("hello"))
	decision := ShareDecision{
		ContactID:      "maep:12D3KooWInv",
		PeerID:         "12D3KooWInv",
		ItemID:         "manual_item_1",
		Topic:          "share.proactive.v1",
		ContentType:    "text/plain",
		PayloadBase64:  payload,
		IdempotencyKey: "manual:key1",
	}

	if _, err := svc.SendDecision(ctx, now, decision, sender); err != nil {
		t.Fatalf("SendDecision(first) error = %v", err)
	}
	second, err := svc.SendDecision(ctx, now.Add(1*time.Minute), decision, sender)
	if err != nil {
		t.Fatalf("SendDecision(second) error = %v", err)
	}
	if sender.calls != 1 {
		t.Fatalf("sender calls mismatch: got %d want 1", sender.calls)
	}
	if !second.Deduped {
		t.Fatalf("second send expected deduped outcome, got=%+v", second)
	}
}

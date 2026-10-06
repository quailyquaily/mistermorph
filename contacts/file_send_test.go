package contacts

import (
	"context"
	"encoding/base64"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

type fileSendTestSender struct {
	calls int
	err   error
}

func (s *fileSendTestSender) Send(context.Context, Contact, ShareDecision) (bool, bool, error) {
	s.calls++
	return s.err == nil, false, s.err
}

func TestSendDecisionWithFile(t *testing.T) {
	now := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	file := &ShareFile{Path: "/cache/weekly.pdf", Filename: "weekly.pdf", Size: 12, SHA256: "abc"}
	tests := []struct {
		name        string
		err         error
		wantStatus  BusDeliveryStatus
		wantPartial bool
		wantRetries int
	}{
		{name: "sent", wantStatus: BusDeliveryStatusSent, wantRetries: 1},
		{name: "partial counts as sent", err: &PartialDeliveryError{Err: errors.New("caption failed")}, wantStatus: BusDeliveryStatusSent, wantPartial: true, wantRetries: 1},
		{name: "upload failed", err: errors.New("upload failed"), wantStatus: BusDeliveryStatusFailed, wantRetries: 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			store := NewFileStore(filepath.Join(t.TempDir(), "contacts"))
			svc := NewService(store)
			if _, err := svc.UpsertContact(ctx, Contact{ContactID: "tg:42", Kind: KindHuman, Channel: ChannelTelegram, TGPrivateChatID: 42}, now); err != nil {
				t.Fatal(err)
			}
			decision := ShareDecision{
				ContactID:      "tg:42",
				ContentType:    "application/json",
				PayloadBase64:  base64.RawURLEncoding.EncodeToString([]byte(`{"text":""}`)),
				IdempotencyKey: "manual:file",
				File:           file,
			}
			sender := &fileSendTestSender{err: tt.err}
			outcome, err := svc.SendDecision(ctx, now, decision, sender)
			if err != nil {
				t.Fatalf("SendDecision() error = %v", err)
			}
			if outcome.Partial != tt.wantPartial || (tt.err == nil) != (outcome.Error == "") {
				t.Fatalf("outcome = %+v", outcome)
			}
			record, ok, err := store.GetBusOutboxRecord(ctx, ChannelTelegram, "manual:file")
			if err != nil || !ok {
				t.Fatalf("GetBusOutboxRecord() = %v, %v", ok, err)
			}
			if record.Status != tt.wantStatus || record.File == nil || *record.File != *file {
				t.Fatalf("record = %+v", record)
			}
			// A retry with the same key sends again only after a failure.
			if _, err := svc.SendDecision(ctx, now, decision, sender); err != nil {
				t.Fatalf("retry error = %v", err)
			}
			if sender.calls != tt.wantRetries {
				t.Fatalf("sender calls = %d, want %d", sender.calls, tt.wantRetries)
			}
		})
	}
}

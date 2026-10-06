package guard

import (
	"context"
	"strings"
	"testing"
)

func TestAuditFileSend(t *testing.T) {
	send := FileSend{
		Recipients: []string{"tg:1", "tg:2"},
		Path:       "/cache/reports/weekly.pdf",
		Filename:   "weekly.pdf",
		Size:       42,
		SHA256:     "abc123",
		Status:     "sent",
	}

	t.Run("records the send", func(t *testing.T) {
		sink := &captureAuditSink{}
		g := New(Config{Enabled: true}, sink, nil)
		ctx := WithAuditContext(context.Background(), g, Meta{RunID: "run-1", Step: 3})
		if err := AuditFileSend(ctx, "contacts_send", send); err != nil {
			t.Fatalf("AuditFileSend() error = %v", err)
		}
		if len(sink.events) != 1 {
			t.Fatalf("captured %d events, want 1", len(sink.events))
		}
		ev := sink.events[0]
		if ev.ActionType != ActionFileSend || ev.ToolName != "contacts_send" || ev.RunID != "run-1" || ev.Step != 3 {
			t.Fatalf("event = %+v", ev)
		}
		for _, want := range []string{`recipients="tg:1,tg:2"`, `path="/cache/reports/weekly.pdf"`, `filename="weekly.pdf"`, "size=42", "sha256=abc123", "status=sent"} {
			if !strings.Contains(ev.ActionSummaryRedacted, want) {
				t.Fatalf("summary %q missing %q", ev.ActionSummaryRedacted, want)
			}
		}
		if ev.ActionHash == "" {
			t.Fatalf("ActionHash is empty")
		}
	})

	t.Run("no guard in context", func(t *testing.T) {
		if err := AuditFileSend(context.Background(), "contacts_send", send); err != nil {
			t.Fatalf("AuditFileSend() error = %v", err)
		}
	})

	t.Run("disabled guard", func(t *testing.T) {
		sink := &captureAuditSink{}
		g := New(Config{Enabled: false}, sink, nil)
		ctx := WithAuditContext(context.Background(), g, Meta{RunID: "run-1"})
		if err := AuditFileSend(ctx, "contacts_send", send); err != nil {
			t.Fatalf("AuditFileSend() error = %v", err)
		}
		if len(sink.events) != 0 {
			t.Fatalf("captured %d events, want 0", len(sink.events))
		}
	})
}

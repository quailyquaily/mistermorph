package builtin

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestResolveSendPayload_MessageTextAutoSessionID(t *testing.T) {
	now := time.Date(2026, 2, 10, 8, 0, 0, 0, time.UTC)
	contentType, payloadBase64, err := resolveSendPayload(map[string]any{
		"message_text": "hello",
	}, now)
	if err != nil {
		t.Fatalf("resolveSendPayload() error = %v", err)
	}
	if contentType != contactsSendContentType {
		t.Fatalf("content_type mismatch: got %q want %q", contentType, contactsSendContentType)
	}

	envelope := decodeEnvelopePayload(t, payloadBase64)
	if text, _ := envelope["text"].(string); text != "hello" {
		t.Fatalf("text mismatch: got %q want %q", text, "hello")
	}
	if sentAt, _ := envelope["sent_at"].(string); sentAt != now.Format(time.RFC3339) {
		t.Fatalf("sent_at mismatch: got %q want %q", sentAt, now.Format(time.RFC3339))
	}
	sessionID, _ := envelope["session_id"].(string)
	assertUUIDv7(t, sessionID)
}

func TestResolveSendPayload_MessageBase64AutoSessionID(t *testing.T) {
	now := time.Date(2026, 2, 10, 8, 0, 0, 0, time.UTC)
	raw, err := json.Marshal(map[string]any{
		"message_id": "msg_1",
		"text":       "hello",
		"sent_at":    now.Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}

	contentType, payloadBase64, err := resolveSendPayload(map[string]any{
		"message_base64": base64.RawURLEncoding.EncodeToString(raw),
	}, now)
	if err != nil {
		t.Fatalf("resolveSendPayload() error = %v", err)
	}
	if contentType != contactsSendContentType {
		t.Fatalf("content_type mismatch: got %q want %q", contentType, contactsSendContentType)
	}

	envelope := decodeEnvelopePayload(t, payloadBase64)
	if messageID, _ := envelope["message_id"].(string); messageID != "msg_1" {
		t.Fatalf("message_id mismatch: got %q want %q", messageID, "msg_1")
	}
	sessionID, _ := envelope["session_id"].(string)
	assertUUIDv7(t, sessionID)
}

func TestResolveSendPayload_MessageBase64UsesParamSessionID(t *testing.T) {
	now := time.Date(2026, 2, 10, 8, 0, 0, 0, time.UTC)
	providedSessionID := mustUUIDv7(t)
	raw, err := json.Marshal(map[string]any{
		"message_id": "msg_2",
		"text":       "hello",
		"sent_at":    now.Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}

	_, payloadBase64, err := resolveSendPayload(map[string]any{
		"message_base64": base64.RawURLEncoding.EncodeToString(raw),
		"session_id":     providedSessionID,
	}, now)
	if err != nil {
		t.Fatalf("resolveSendPayload() error = %v", err)
	}

	envelope := decodeEnvelopePayload(t, payloadBase64)
	if sessionID, _ := envelope["session_id"].(string); sessionID != providedSessionID {
		t.Fatalf("session_id mismatch: got %q want %q", sessionID, providedSessionID)
	}
}

func TestResolveSendPayload_RejectsInvalidSessionID(t *testing.T) {
	_, _, err := resolveSendPayload(map[string]any{
		"message_text": "hello",
		"session_id":   "not-a-uuidv7",
	}, time.Date(2026, 2, 10, 8, 0, 0, 0, time.UTC))
	if err == nil {
		t.Fatalf("resolveSendPayload() expected error for invalid session_id")
	}
	if !strings.Contains(err.Error(), "uuid_v7") {
		t.Fatalf("resolveSendPayload() error mismatch: got %q", err.Error())
	}
}

func decodeEnvelopePayload(t *testing.T, payloadBase64 string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(payloadBase64)
	if err != nil {
		t.Fatalf("base64 decode error = %v", err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	return envelope
}

func mustUUIDv7(t *testing.T) string {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatalf("uuid.NewV7() error = %v", err)
	}
	return id.String()
}

func assertUUIDv7(t *testing.T, value string) {
	t.Helper()
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		t.Fatalf("uuid.Parse() error = %v", err)
	}
	if parsed.Version() != uuid.Version(7) {
		t.Fatalf("uuid version mismatch: got %d want %d", parsed.Version(), 7)
	}
}

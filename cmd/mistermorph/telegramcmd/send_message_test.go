package telegramcmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSendMessageMarkdownV2_EscapesBeforeSendingMarkdownV2(t *testing.T) {
	var parseModes []string
	var texts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/sendMessage") {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		var req telegramSendMessageRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		parseModes = append(parseModes, req.ParseMode)
		texts = append(texts, req.Text)

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	api := newTelegramAPI(srv.Client(), srv.URL, "TOKEN")
	if err := api.sendMessageMarkdownV2(context.Background(), 1001, "hello-world", true); err != nil {
		t.Fatalf("sendMessageMarkdownV2() error = %v", err)
	}

	if len(parseModes) != 1 {
		t.Fatalf("expected 1 send attempt, got %d", len(parseModes))
	}
	if parseModes[0] != "MarkdownV2" {
		t.Fatalf("first attempt parse_mode mismatch: got %q", parseModes[0])
	}
	if texts[0] != "hello\\-world" {
		t.Fatalf("MarkdownV2 text should be escaped on first attempt: got %q", texts[0])
	}
}

func TestSendMessageMarkdownV2_FallbackToPlainOnParseError(t *testing.T) {
	var parseModes []string
	var texts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/sendMessage") {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		var req telegramSendMessageRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		parseModes = append(parseModes, req.ParseMode)
		texts = append(texts, req.Text)

		w.Header().Set("Content-Type", "application/json")
		if len(parseModes) == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"ok":false,"error_code":400,"description":"Bad Request: can't parse entities: Character '-' is reserved and must be escaped"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	api := newTelegramAPI(srv.Client(), srv.URL, "TOKEN")
	if err := api.sendMessageMarkdownV2(context.Background(), 1001, "hello-world", true); err != nil {
		t.Fatalf("sendMessageMarkdownV2() error = %v", err)
	}

	if len(parseModes) != 2 {
		t.Fatalf("expected 2 send attempts, got %d", len(parseModes))
	}
	if parseModes[0] != "MarkdownV2" || parseModes[1] != "" {
		t.Fatalf("unexpected parse_mode attempts: %#v", parseModes)
	}
	if texts[0] != "hello\\-world" {
		t.Fatalf("first attempt text should be escaped MarkdownV2: got %q", texts[0])
	}
	if texts[1] != "hello-world" {
		t.Fatalf("plain-text fallback should use original text: got %q", texts[1])
	}
}

func TestSendMessageMarkdownV2_DoesNotFallbackOnNonParseError(t *testing.T) {
	var parseModes []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/sendMessage") {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		var req telegramSendMessageRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		parseModes = append(parseModes, req.ParseMode)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"ok":false,"error_code":401,"description":"Unauthorized"}`))
	}))
	defer srv.Close()

	api := newTelegramAPI(srv.Client(), srv.URL, "TOKEN")
	err := api.sendMessageMarkdownV2(context.Background(), 1001, "hello", true)
	if err == nil {
		t.Fatalf("expected error")
	}
	if len(parseModes) != 1 {
		t.Fatalf("expected no plain-text fallback for non-parse errors, got %d attempts", len(parseModes))
	}
	if parseModes[0] != "MarkdownV2" {
		t.Fatalf("unexpected parse_mode on first attempt: %q", parseModes[0])
	}
}

func TestSendMessageMarkdownV2Reply_IncludesReplyToMessageID(t *testing.T) {
	var gotReplyTo int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/sendMessage") {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		var req telegramSendMessageRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		gotReplyTo = req.ReplyToMessageID
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	api := newTelegramAPI(srv.Client(), srv.URL, "TOKEN")
	if err := api.sendMessageMarkdownV2Reply(context.Background(), 1001, "hello", true, 7788); err != nil {
		t.Fatalf("sendMessageMarkdownV2Reply() error = %v", err)
	}
	if gotReplyTo != 7788 {
		t.Fatalf("reply_to_message_id mismatch: got %d want 7788", gotReplyTo)
	}
}

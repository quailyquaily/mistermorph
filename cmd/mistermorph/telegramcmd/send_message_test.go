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

func TestSendMessageMarkdownV2_FallbackOnlyOnParseError(t *testing.T) {
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
	if parseModes[0] != "MarkdownV2" {
		t.Fatalf("first attempt parse_mode mismatch: got %q", parseModes[0])
	}
	if parseModes[1] != "" {
		t.Fatalf("fallback attempt should be plain text, got parse_mode=%q", parseModes[1])
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

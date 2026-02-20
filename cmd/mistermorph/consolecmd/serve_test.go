package consolecmd

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestWriteJSONSetsNoCacheHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, 200, map[string]any{"ok": true})

	resp := rec.Result()
	if got := resp.Header.Get("Cache-Control"); got == "" {
		t.Fatalf("Cache-Control header is empty")
	}
	if got := resp.Header.Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma = %q, want %q", got, "no-cache")
	}
	if got := resp.Header.Get("Expires"); got != "0" {
		t.Fatalf("Expires = %q, want %q", got, "0")
	}
	if got := resp.Header.Get("Vary"); got != "Authorization" {
		t.Fatalf("Vary = %q, want %q", got, "Authorization")
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	var parsed map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if ok, _ := parsed["ok"].(bool); !ok {
		t.Fatalf("body.ok = %#v, want true", parsed["ok"])
	}
}

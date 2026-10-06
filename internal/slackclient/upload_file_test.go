package slackclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/testhttp"
)

func TestClientUploadFile(t *testing.T) {
	t.Run("ok", func(t *testing.T) {
		var gotFileContent string
		var server testhttp.Server
		server = testhttp.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/files.getUploadURLExternal":
				if got := strings.TrimSpace(r.Header.Get("Authorization")); got != "Bearer xoxb-test" {
					t.Fatalf("authorization = %q", got)
				}
				if got := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))); !strings.Contains(got, "application/x-www-form-urlencoded") {
					t.Fatalf("content-type = %q", got)
				}
				rawBody, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatalf("read payload: %v", err)
				}
				payload, err := url.ParseQuery(string(rawBody))
				if err != nil {
					t.Fatalf("parse payload: %v", err)
				}
				if got := strings.TrimSpace(payload.Get("filename")); got != "result.txt" {
					t.Fatalf("filename = %q, want %q", got, "result.txt")
				}
				if got := strings.TrimSpace(payload.Get("length")); got != "11" {
					t.Fatalf("length = %q, want %q", got, "11")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ok":         true,
					"upload_url": server.URL + "/upload/v1/mock",
					"file_id":    "F123",
				})
			case "/upload/v1/mock":
				if got := strings.TrimSpace(r.Header.Get("Authorization")); got != "" {
					t.Fatalf("authorization = %q, want empty", got)
				}
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatalf("read upload body: %v", err)
				}
				gotFileContent = string(raw)
				_, _ = w.Write([]byte("ok"))
			case "/files.completeUploadExternal":
				if got := strings.TrimSpace(r.Header.Get("Authorization")); got != "Bearer xoxb-test" {
					t.Fatalf("authorization = %q", got)
				}
				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Fatalf("decode payload: %v", err)
				}
				if got := strings.TrimSpace(payload["channel_id"].(string)); got != "C123" {
					t.Fatalf("channel_id = %q, want %q", got, "C123")
				}
				if got := strings.TrimSpace(payload["thread_ts"].(string)); got != "1739667600.000100" {
					t.Fatalf("thread_ts = %q, want %q", got, "1739667600.000100")
				}
				if got := strings.TrimSpace(payload["initial_comment"].(string)); got != "done" {
					t.Fatalf("initial_comment = %q, want %q", got, "done")
				}
				files, ok := payload["files"].([]any)
				if !ok || len(files) != 1 {
					t.Fatalf("files payload = %#v, want one item", payload["files"])
				}
				fileMeta, ok := files[0].(map[string]any)
				if !ok {
					t.Fatalf("files[0] payload = %#v, want map", files[0])
				}
				if got := strings.TrimSpace(fileMeta["id"].(string)); got != "F123" {
					t.Fatalf("file id = %q, want %q", got, "F123")
				}
				if got := strings.TrimSpace(fileMeta["title"].(string)); got != "Result" {
					t.Fatalf("file title = %q, want %q", got, "Result")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
			default:
				t.Fatalf("unexpected path: %s", r.URL.Path)
			}
		}))

		tmp := t.TempDir()
		localFile := filepath.Join(tmp, "result.txt")
		if err := os.WriteFile(localFile, []byte("hello slack"), 0o600); err != nil {
			t.Fatalf("write temp file: %v", err)
		}

		client := New(server.Client, server.URL, "xoxb-test")
		if err := client.UploadFile(context.Background(), "C123", "1739667600.000100", localFile, "result.txt", "Result", "done"); err != nil {
			t.Fatalf("uploadFile() error = %v", err)
		}
		if gotFileContent != "hello slack" {
			t.Fatalf("uploaded file content = %q, want %q", gotFileContent, "hello slack")
		}
	})

	t.Run("complete upload slack error", func(t *testing.T) {
		var server testhttp.Server
		server = testhttp.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/files.getUploadURLExternal":
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ok":         true,
					"upload_url": server.URL + "/upload/v1/mock",
					"file_id":    "F123",
				})
			case "/upload/v1/mock":
				_, _ = w.Write([]byte("ok"))
			case "/files.completeUploadExternal":
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ok":    false,
					"error": "missing_scope",
				})
			default:
				t.Fatalf("unexpected path: %s", r.URL.Path)
			}
		}))

		tmp := t.TempDir()
		localFile := filepath.Join(tmp, "result.txt")
		if err := os.WriteFile(localFile, []byte("hello slack"), 0o600); err != nil {
			t.Fatalf("write temp file: %v", err)
		}

		client := New(server.Client, server.URL, "xoxb-test")
		err := client.UploadFile(context.Background(), "C123", "", localFile, "", "", "")
		if err == nil {
			t.Fatalf("expected error")
		}
		if !strings.Contains(err.Error(), "missing_scope") {
			t.Fatalf("error = %v, want missing_scope", err)
		}
	})

	t.Run("empty file rejected before slack call", func(t *testing.T) {
		server := testhttp.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Fatalf("unexpected slack request: %s", r.URL.Path)
		}))

		tmp := t.TempDir()
		localFile := filepath.Join(tmp, "empty.txt")
		if err := os.WriteFile(localFile, nil, 0o600); err != nil {
			t.Fatalf("write temp file: %v", err)
		}

		client := New(server.Client, server.URL, "xoxb-test")
		err := client.UploadFile(context.Background(), "C123", "", localFile, "", "", "")
		if err == nil {
			t.Fatalf("expected error")
		}
		if !strings.Contains(err.Error(), "file length is invalid") {
			t.Fatalf("error = %v, want file length is invalid", err)
		}
	})
}

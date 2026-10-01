package whatsappapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestDownloadMediaChecksHostSizeAndDigest(t *testing.T) {
	data := []byte("pdf bytes")
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	var base string
	client, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("%s without the token", r.URL.Path)
		}
		switch r.URL.Path {
		case "/media/good":
			_ = json.NewEncoder(w).Encode(MediaInfo{URL: base + "/content/good", MimeType: "application/pdf", SHA256: digest, FileSize: int64(len(data)), ID: "good"})
		case "/media/elsewhere":
			_ = json.NewEncoder(w).Encode(MediaInfo{URL: "https://evil.example/x", FileSize: 3})
		case "/media/big":
			_ = json.NewEncoder(w).Encode(MediaInfo{URL: base + "/content/good", FileSize: 99})
		case "/media/tampered":
			_ = json.NewEncoder(w).Encode(MediaInfo{URL: base + "/content/good", SHA256: strings.Repeat("0", 64)})
		case "/content/good":
			_, _ = w.Write(data)
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	})
	base = client.baseURL
	got, info, err := client.DownloadMedia(context.Background(), "good", 0)
	if err != nil || string(got) != string(data) || info.MimeType != "application/pdf" {
		t.Fatalf("DownloadMedia = %q, %+v, %v", got, info, err)
	}
	if !SHA256Matches(got, base64.StdEncoding.EncodeToString(sum[:])) {
		t.Fatal("SHA256Matches rejected the right digest")
	}
	for id, want := range map[string]string{"elsewhere": "WhatsApp host", "big": "over 10", "tampered": "digest"} {
		if _, _, err := client.DownloadMedia(context.Background(), id, 10); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("DownloadMedia(%s) = %v, want %q", id, err, want)
		}
	}
	if _, _, err := client.DownloadMedia(context.Background(), "../x", 0); err == nil {
		t.Fatal("path in a media id accepted")
	}
}

func TestUploadMediaThenSendDocument(t *testing.T) {
	var sent map[string]any
	client, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/media":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			file, header, err := r.FormFile("file")
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := io.ReadAll(file)
			if r.FormValue("messaging_product") != "whatsapp" || r.FormValue("type") != "application/pdf" || header.Filename != "r.pdf" || string(raw) != "%PDF" {
				t.Errorf("upload form = %v %q %q", r.MultipartForm.Value, header.Filename, raw)
			}
			_, _ = io.WriteString(w, `{"id":"M1"}`)
		case "/messages":
			_ = json.NewDecoder(r.Body).Decode(&sent)
			_, _ = io.WriteString(w, `{"messages":[{"id":"wamid.1"}]}`)
		}
	})
	id, err := client.UploadMedia(context.Background(), "dir/r.pdf", "application/pdf", []byte("%PDF"))
	if err != nil || id != "M1" {
		t.Fatalf("UploadMedia = %q, %v", id, err)
	}
	if _, err := client.SendMedia(context.Background(), "42", "document", id, "the report", "dir/r.pdf"); err != nil {
		t.Fatal(err)
	}
	doc, _ := sent["document"].(map[string]any)
	if sent["to"] != "user:42" || sent["type"] != "document" || doc["id"] != "M1" || doc["caption"] != "the report" || doc["filename"] != "r.pdf" {
		t.Fatalf("sent = %v", sent)
	}
	if _, err := client.UploadMedia(context.Background(), "big.png", "image/png", make([]byte, MaxImageBytes+1)); err == nil {
		t.Fatal("oversized image accepted")
	}
	if MediaType("image/jpeg") != "image" || MediaType("audio/ogg; codecs=opus") != "audio" || MediaType("application/zip") != "document" {
		t.Fatal("MediaType mapping")
	}
}

package wechatapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestECBRoundTripAndPaddingChecks(t *testing.T) {
	key := []byte("0123456789abcdef")
	for _, size := range []int{0, 1, 15, 16, 17, 100} {
		plain := bytes.Repeat([]byte{'x'}, size)
		enc, err := EncryptECB(plain, key)
		if err != nil || len(enc)%16 != 0 || len(enc) <= size {
			t.Fatalf("EncryptECB(%d) = %d bytes, %v", size, len(enc), err)
		}
		dec, err := DecryptECB(enc, key)
		if err != nil || !bytes.Equal(dec, plain) {
			t.Fatalf("DecryptECB(%d) = %q, %v", size, dec, err)
		}
	}
	enc, _ := EncryptECB([]byte("hello"), key)
	if _, err := DecryptECB(enc, []byte("fedcba9876543210")); err == nil {
		t.Fatal("wrong key decrypted with valid padding")
	}
	if _, err := DecryptECB(enc[:15], key); err == nil {
		t.Fatal("partial block accepted")
	}
	if _, err := EncryptECB([]byte("x"), []byte("short")); err == nil {
		t.Fatal("short key accepted")
	}
}

func TestParseAESKeyAcceptsRawAndHexForms(t *testing.T) {
	key := []byte("0123456789abcdef")
	for name, encoded := range map[string]string{
		"raw": base64.StdEncoding.EncodeToString(key),
		"hex": base64.StdEncoding.EncodeToString([]byte(hex.EncodeToString(key))),
	} {
		got, err := ParseAESKey(encoded)
		if err != nil || !bytes.Equal(got, key) {
			t.Fatalf("%s: ParseAESKey = %x, %v", name, got, err)
		}
	}
	if _, err := ParseAESKey(base64.StdEncoding.EncodeToString([]byte("tooshort"))); err == nil {
		t.Fatal("8-byte key accepted")
	}
}

func TestDownloadMediaDecryptsAndRefusesOtherHosts(t *testing.T) {
	key := []byte("0123456789abcdef")
	enc, _ := EncryptECB([]byte("picture"), key)
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/c2c/download" || r.URL.Query().Get("encrypted_query_param") != "P" {
			t.Errorf("download request = %s", r.URL)
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("bot token sent to the CDN")
		}
		_, _ = w.Write(enc)
	}))
	defer cdn.Close()
	client, err := NewClient("tok", Options{BaseURL: cdn.URL, CDNBaseURL: cdn.URL + "/c2c", HTTPClient: cdn.Client()})
	if err != nil {
		t.Fatal(err)
	}
	var msg Message
	raw := `{"item_list":[{"type":2,"image_item":{"aeskey":"` + hex.EncodeToString(key) + `","media":{"encrypt_query_param":"P"}}},
		{"type":4,"file_item":{"file_name":"a.pdf","len":"7","media":{"full_url":"https://evil.example/x","aes_key":"` + base64.StdEncoding.EncodeToString(key) + `"}}},
		{"type":3,"voice_item":{"text":"transcribed","media":{"encrypt_query_param":"V"}}}]}`
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		t.Fatal(err)
	}
	refs := msg.Media()
	if len(refs) != 2 || refs[0].Kind != MediaImage || refs[1].Kind != MediaFile || refs[1].Name != "a.pdf" || refs[1].Size != 7 {
		t.Fatalf("Media() = %+v", refs)
	}
	got, err := client.DownloadMedia(context.Background(), refs[0])
	if err != nil || string(got) != "picture" {
		t.Fatalf("DownloadMedia = %q, %v", got, err)
	}
	if _, err := client.DownloadMedia(context.Background(), refs[1]); err == nil || !strings.Contains(err.Error(), "WeChat host") {
		t.Fatalf("download from another host: %v", err)
	}
}

func TestUploadMediaThenSendFile(t *testing.T) {
	var uploaded []byte
	var sent map[string]any
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ilink/bot/getuploadurl":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["to_user_id"] != "u1" || body["media_type"] != float64(uploadFile) || body["rawsize"] != float64(5) || body["filesize"] != float64(16) {
				t.Errorf("getuploadurl body = %v", body)
			}
			_, _ = io.WriteString(w, `{"ret":0,"upload_param":"UP"}`)
		case "/c2c/upload":
			if r.URL.Query().Get("encrypted_query_param") != "UP" || r.URL.Query().Get("filekey") == "" {
				t.Errorf("upload url = %s", r.URL)
			}
			uploaded, _ = io.ReadAll(r.Body)
			w.Header().Set("x-encrypted-param", "DL")
		case "/ilink/bot/sendmessage":
			var body struct {
				Msg map[string]any `json:"msg"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			sent = body.Msg
			_, _ = io.WriteString(w, `{"ret":0}`)
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	}))
	defer server.Close()
	client, err := NewClient("tok", Options{BaseURL: server.URL, CDNBaseURL: server.URL + "/c2c", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	up, err := client.UploadMedia(context.Background(), "u1", MediaFile, []byte("hello"))
	if err != nil || up.DownloadParam != "DL" || len(uploaded) != 16 {
		t.Fatalf("UploadMedia = %+v, %v (uploaded %d bytes)", up, err, len(uploaded))
	}
	key, _ := hex.DecodeString(up.HexKey)
	if plain, err := DecryptECB(uploaded, key); err != nil || string(plain) != "hello" {
		t.Fatalf("uploaded ciphertext decrypts to %q, %v", plain, err)
	}
	if _, err := client.SendMedia(context.Background(), "u1", "ctx", MediaFile, "a.txt", up); err != nil {
		t.Fatal(err)
	}
	items, _ := sent["item_list"].([]any)
	item, _ := items[0].(map[string]any)
	file, _ := item["file_item"].(map[string]any)
	media, _ := file["media"].(map[string]any)
	if item["type"] != float64(ItemFile) || file["file_name"] != "a.txt" || file["len"] != "5" || media["encrypt_query_param"] != "DL" {
		t.Fatalf("sent item = %v", item)
	}
	if got, err := ParseAESKey(media["aes_key"].(string)); err != nil || !bytes.Equal(got, key) {
		t.Fatalf("sent aes_key = %v, %v", media["aes_key"], err)
	}
	if _, err := client.SendMedia(context.Background(), "u1", "", MediaFile, "a.txt", up); err == nil {
		t.Fatal("send without a conversation context succeeded")
	}
}

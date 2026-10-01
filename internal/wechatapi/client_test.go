package wechatapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newTestClient(t *testing.T, token string, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewClient(token, Options{BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestBotRequestsCarryTheProtocolHeadersAndBaseInfo(t *testing.T) {
	client := newTestClient(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ilink/bot/sendmessage" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("AuthorizationType") != "ilink_bot_token" ||
			r.Header.Get("iLink-App-Id") != "bot" || r.Header.Get("iLink-App-ClientVersion") != "132104" {
			t.Errorf("headers = %v", r.Header)
		}
		uin, err := base64.StdEncoding.DecodeString(r.Header.Get("X-WECHAT-UIN"))
		if _, convErr := strconv.ParseUint(string(uin), 10, 32); err != nil || convErr != nil {
			t.Errorf("X-WECHAT-UIN = %q", r.Header.Get("X-WECHAT-UIN"))
		}
		var body struct {
			Msg struct {
				To       string `json:"to_user_id"`
				Context  string `json:"context_token"`
				Type     int    `json:"message_type"`
				State    int    `json:"message_state"`
				ItemList []Item `json:"item_list"`
			} `json:"msg"`
			BaseInfo baseInfo `json:"base_info"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Msg.To != "u1" || body.Msg.Context != "ctx" || body.Msg.Type != 2 || body.Msg.State != 2 ||
			len(body.Msg.ItemList) != 1 || body.Msg.ItemList[0].TextItem.Text != "hi" || body.BaseInfo.ChannelVersion != ProtocolVersion {
			t.Errorf("body = %+v", body)
		}
		_, _ = io.WriteString(w, `{"ret":0}`)
	})
	if _, err := client.SendText(context.Background(), "u1", "ctx", "hi"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.SendText(context.Background(), "u1", "", "hi"); err == nil {
		t.Fatal("a reply without a context token was sent")
	}
}

func TestLoginPollsWithoutCredentials(t *testing.T) {
	client := newTestClient(t, "", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ilink/bot/get_bot_qrcode":
			if r.URL.Query().Get("bot_type") != "3" || r.Header.Get("Authorization") != "" || r.Header.Get("AuthorizationType") != "ilink_bot_token" {
				t.Errorf("qrcode request = %s %v", r.URL, r.Header)
			}
			_, _ = io.WriteString(w, `{"qrcode":"Q1","qrcode_img_content":"https://example.test/qr"}`)
		case "/ilink/bot/get_qrcode_status":
			if r.Header.Get("Authorization") != "" || r.Header.Get("AuthorizationType") != "" || r.Header.Get("X-WECHAT-UIN") != "" || r.Header.Get("iLink-App-Id") != "bot" {
				t.Errorf("status request headers = %v", r.Header)
			}
			if r.URL.Query().Get("qrcode") != "Q1" || r.URL.Query().Get("verify_code") != "123456" {
				t.Errorf("status query = %s", r.URL.RawQuery)
			}
			_, _ = io.WriteString(w, `{"status":"confirmed","bot_token":"T","ilink_bot_id":"b1@im.bot","baseurl":"https://api.example.test","ilink_user_id":"u1"}`)
		}
	})
	code, err := client.GetQRCode(context.Background())
	if err != nil || code.Code != "Q1" || code.Image != "https://example.test/qr" {
		t.Fatalf("GetQRCode = %+v, %v", code, err)
	}
	status, err := client.QRCodeStatus(context.Background(), "Q1", "123456")
	if err != nil || status.Status != QRConfirmed || status.BotToken != "T" || status.BotID != "b1@im.bot" || status.BaseURL != "https://api.example.test" {
		t.Fatalf("QRCodeStatus = %+v, %v", status, err)
	}
}

func TestRedirectHostMustBeAHostName(t *testing.T) {
	if got, err := RedirectBaseURL("sh.ilinkai.weixin.qq.com"); err != nil || got != "https://sh.ilinkai.weixin.qq.com" {
		t.Fatalf("RedirectBaseURL = %q, %v", got, err)
	}
	for _, bad := range []string{"", "evil.test/path", "user@evil.test", "evil.test?x", "a b"} {
		if _, err := RedirectBaseURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestGetUpdatesKeepsIDPrecisionAndReadsText(t *testing.T) {
	client := newTestClient(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["get_updates_buf"] != "cursor-1" {
			t.Errorf("buf = %v", body["get_updates_buf"])
		}
		_, _ = io.WriteString(w, `{"ret":0,"get_updates_buf":"cursor-2","longpolling_timeout_ms":30000,"msgs":[
			{"message_id":9007199254740993,"from_user_id":"u1","message_type":1,"create_time_ms":1790000000000,"context_token":"ctx",
			 "item_list":[{"type":1,"text_item":{"text":" hello "},"ref_msg":{"message_item":{"type":1,"text_item":{"text":"quoted"}}}},
			              {"type":3,"voice_item":{"text":"spoken words"}}]},
			{"message_id":2,"from_user_id":"u1","message_type":1,"item_list":[{"type":2,"image_item":{"aeskey":"x"}}]}
		]}`)
	})
	updates, err := client.GetUpdates(context.Background(), "cursor-1", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if updates.Buf != "cursor-2" || updates.LongPollTimeout != 30*time.Second || len(updates.Messages) != 2 {
		t.Fatalf("updates = %+v", updates)
	}
	first := updates.Messages[0]
	if first.ID() != "9007199254740993" || first.Text() != "hello\nspoken words" || first.QuotedText() != "quoted" || first.HasMedia() || first.SentAt().Unix() != 1790000000 {
		t.Fatalf("first = %+v text=%q", first, first.Text())
	}
	if second := updates.Messages[1]; second.Text() != "" || !second.HasMedia() {
		t.Fatalf("second = %+v", second)
	}
}

func TestBusinessErrorsAndExpiredSessions(t *testing.T) {
	client := newTestClient(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ret":-14,"errmsg":"session timeout"}`)
	})
	_, err := client.GetUpdates(context.Background(), "", time.Second)
	if !IsSessionExpired(err) || !strings.Contains(err.Error(), "session timeout") {
		t.Fatalf("err = %v", err)
	}
	other := newTestClient(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ret":0,"errcode":-2,"errmsg":"busy"}`)
	})
	_, err = other.SendText(context.Background(), "u1", "ctx", "hi")
	if err == nil || IsSessionExpired(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestALongPollThatTimesOutIsEmpty(t *testing.T) {
	release := make(chan struct{})
	client := newTestClient(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	defer close(release)
	client.http.Timeout = 50 * time.Millisecond
	updates, err := client.GetUpdates(context.Background(), "c", time.Second)
	if err != nil || len(updates.Messages) != 0 || updates.Buf != "" {
		t.Fatalf("GetUpdates = %+v, %v", updates, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.GetUpdates(ctx, "c", time.Second); err == nil {
		t.Fatal("a cancelled poll returned no error")
	}
}

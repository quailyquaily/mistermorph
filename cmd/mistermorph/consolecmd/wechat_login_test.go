package consolecmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/quailyquaily/mistermorph/internal/wechatlogin"
	"github.com/spf13/viper"
)

func useConsoleTestConfig(t *testing.T, content string) string {
	t.Helper()
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	prevConfig, hadConfig := viper.Get("config"), viper.IsSet("config")
	viper.Set("config", configPath)
	t.Cleanup(func() {
		if hadConfig {
			viper.Set("config", prevConfig)
		} else {
			viper.Set("config", nil)
		}
	})
	return configPath
}

func TestWeChatLoginFromConsoleSavesTheTokenServerSide(t *testing.T) {
	ilink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "get_bot_qrcode"):
			_, _ = io.WriteString(w, `{"qrcode":"Q","qrcode_img_content":"https://qr.example.test/Q"}`)
		case r.URL.Query().Get("verify_code") == "":
			_, _ = io.WriteString(w, `{"status":"need_verifycode"}`)
		default:
			_, _ = io.WriteString(w, `{"status":"confirmed","bot_token":"SECRET","ilink_bot_id":"bot@im.bot","ilink_user_id":"me@im.wechat"}`)
		}
	}))
	defer ilink.Close()
	configPath := useConsoleTestConfig(t, "wechat:\n  task_timeout: 5m\n")
	store := &consoleSettingsTestOSStore{}
	srv := &server{secretStore: store, wechatLogins: newWeChatLoginStore()}
	srv.wechatLogins.options = wechatlogin.Options{BaseURL: ilink.URL}

	post := func(handler http.HandlerFunc, body string) map[string]any {
		t.Helper()
		rec := httptest.NewRecorder()
		handler(rec, httptest.NewRequest(http.MethodPost, "/api/settings/wechat/login", strings.NewReader(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "SECRET") {
			t.Fatalf("response exposed the bot token: %s", rec.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	started := post(srv.handleWeChatLoginStart, "")
	if started["qr_url"] != "https://qr.example.test/Q" {
		t.Fatalf("start = %v", started)
	}
	id, _ := started["session_id"].(string)
	step := post(srv.handleWeChatLoginPoll, `{"session_id":"`+id+`"}`)
	if step["status"] != "need_verifycode" || step["done"] != false {
		t.Fatalf("first poll = %v", step)
	}
	step = post(srv.handleWeChatLoginPoll, `{"session_id":"`+id+`","verify_code":"123456"}`)
	if step["connected"] != true || step["bot_id"] != "bot@im.bot" || step["user_id"] != "me@im.wechat" {
		t.Fatalf("second poll = %v", step)
	}
	raw, _ := os.ReadFile(configPath)
	if len(store.puts) != 1 || !strings.Contains(string(raw), secref.OSSecretRef(store.puts[0])) || strings.Contains(string(raw), "SECRET") {
		t.Fatalf("token not saved as an OS secret ref (puts %v):\n%s", store.puts, raw)
	}
	if !strings.Contains(string(raw), "task_timeout: 5m") {
		t.Fatalf("login dropped other wechat settings:\n%s", raw)
	}

	rec := httptest.NewRecorder()
	srv.handleWeChatLoginPoll(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"session_id":"`+id+`"}`)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("finished login polled again: status %d", rec.Code)
	}

	post(srv.handleWeChatLogout, "")
	raw, _ = os.ReadFile(configPath)
	if strings.Contains(string(raw), "bot_token") || len(store.values) != 0 {
		t.Fatalf("logout left credentials (store %v):\n%s", store.values, raw)
	}
}

func TestConsoleSettingsWeChatAndWhatsApp(t *testing.T) {
	const tokenID = "b_LsX7HLzAR3OShG7YjRcw"
	configPath := useConsoleTestConfig(t, "wechat:\n  bot_token: "+secref.OSSecretRef(tokenID)+"\n  bot_id: bot@im.bot\n")
	store := &consoleSettingsTestOSStore{values: map[string]string{tokenID: "wechat-token"}}
	srv := &server{secretStore: store}
	body := `{"whatsapp":{"api_token":"wa-key"}}`
	rec := httptest.NewRecorder()
	srv.handleConsoleSettings(rec, httptest.NewRequest(http.MethodPut, "/api/settings/console", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	raw, _ := os.ReadFile(configPath)
	text := string(raw)
	if !strings.Contains(text, secref.OSSecretRef(tokenID)) || !strings.Contains(text, "bot@im.bot") {
		t.Fatalf("wechat settings not kept:\n%s", text)
	}
	if strings.Contains(text, "wa-key") || len(store.puts) != 1 || store.labels[store.puts[0]] != "whatsapp.api_token" {
		t.Fatalf("whatsapp key not stored as an OS secret:\n%s", text)
	}
	var payload struct {
		WeChat       consoleWeChatSettingsPayload       `json:"wechat"`
		WhatsApp     consoleWhatsAppSettingsPayload     `json:"whatsapp"`
		SecretFields consoleSettingsSecretFieldsPayload `json:"secret_fields"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.WeChat.BotToken != "" || payload.WhatsApp.APIToken != "" || payload.WeChat.BotID != "bot@im.bot" {
		t.Fatalf("response = %+v", payload)
	}
	if !payload.SecretFields.WeChat["bot_token"].Configured || !payload.SecretFields.WhatsApp["api_token"].Configured {
		t.Fatalf("secret fields = %+v", payload.SecretFields)
	}
}

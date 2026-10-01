package channelopts

import (
	"testing"
	"time"
)

func TestBuildPrivateChannelRunOptions(t *testing.T) {
	r := stubConfigReader{
		"wechat.bot_token":        " tok ",
		"wechat.bot_id":           "bot@im.bot",
		"wechat.allowed_user_ids": []string{"u1", " u1 ", "u2"},
		"wechat.max_concurrency":  4,
		"whatsapp.api_token":      "wa",
		"whatsapp.task_timeout":   2 * time.Minute,
		"timeout":                 time.Minute,
	}
	wechat := BuildWeChatRunOptions(WeChatConfigFromReader(r), "console", false, true)
	if wechat.BotToken != "tok" || wechat.BotID != "bot@im.bot" || wechat.RuntimeLabel != "console" || wechat.MaxConcurrency != 4 ||
		len(wechat.AllowedUserIDs) != 2 || wechat.TaskTimeout != time.Minute || !wechat.InspectRequest {
		t.Fatalf("wechat = %+v", wechat)
	}
	whatsapp := BuildWhatsAppRunOptions(WhatsAppConfigFromReader(r), "", false, false)
	if whatsapp.APIToken != "wa" || whatsapp.TaskTimeout != 2*time.Minute || len(whatsapp.AllowedUserIDs) != 0 {
		t.Fatalf("whatsapp = %+v", whatsapp)
	}
}

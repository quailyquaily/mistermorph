package bus

import "testing"

func TestBuildConversationKey(t *testing.T) {
	key, err := BuildConversationKey(ChannelTelegram, "-1001")
	if err != nil {
		t.Fatalf("BuildConversationKey() error = %v", err)
	}
	if key != "tg:-1001" {
		t.Fatalf("conversation key mismatch: got %q", key)
	}
}

func TestBuildAndParseTelegramTopicConversationKey(t *testing.T) {
	key, err := BuildTelegramTopicConversationKey("-1001", 4425)
	if err != nil {
		t.Fatalf("BuildTelegramTopicConversationKey() error = %v", err)
	}
	if key != "tg:-1001_4425" {
		t.Fatalf("conversation key mismatch: got %q", key)
	}

	chatID, messageThreadID, err := ParseTelegramConversationKey(key)
	if err != nil {
		t.Fatalf("ParseTelegramConversationKey() error = %v", err)
	}
	if chatID != -1001 || messageThreadID != 4425 {
		t.Fatalf("parsed key mismatch: chat_id=%d thread_id=%d", chatID, messageThreadID)
	}
}

func TestParseTelegramConversationKeyWithoutTopic(t *testing.T) {
	chatID, messageThreadID, err := ParseTelegramConversationKey("tg:-1001")
	if err != nil {
		t.Fatalf("ParseTelegramConversationKey() error = %v", err)
	}
	if chatID != -1001 || messageThreadID != 0 {
		t.Fatalf("parsed key mismatch: chat_id=%d thread_id=%d", chatID, messageThreadID)
	}
}

func TestBuildConversationKeyConsole(t *testing.T) {
	key, err := BuildConversationKey(ChannelConsole, "0195a5e9-1a2b-7c3d-8e4f-123456789abc")
	if err != nil {
		t.Fatalf("BuildConversationKey() error = %v", err)
	}
	if key != "console:0195a5e9-1a2b-7c3d-8e4f-123456789abc" {
		t.Fatalf("conversation key mismatch: got %q", key)
	}
}

func TestBuildConversationKeyLine(t *testing.T) {
	key, err := BuildLineConversationKey("Cgroup123")
	if err != nil {
		t.Fatalf("BuildLineConversationKey() error = %v", err)
	}
	if key != "line:Cgroup123" {
		t.Fatalf("conversation key mismatch: got %q", key)
	}
}

func TestBuildConversationKeyLark(t *testing.T) {
	key, err := BuildLarkConversationKey("oc_group123")
	if err != nil {
		t.Fatalf("BuildLarkConversationKey() error = %v", err)
	}
	if key != "lark:oc_group123" {
		t.Fatalf("conversation key mismatch: got %q", key)
	}
}

func TestBuildConversationKeyMixin(t *testing.T) {
	key, err := BuildMixinConversationKey("8f7059b9-b1b2-4ed8-a99f-4ac2f07a9a34")
	if err != nil {
		t.Fatalf("BuildMixinConversationKey() error = %v", err)
	}
	if key != "mixin:8f7059b9-b1b2-4ed8-a99f-4ac2f07a9a34" {
		t.Fatalf("key = %q", key)
	}
}

func TestDiscordConversationKey(t *testing.T) {
	key, err := BuildDiscordConversationKey(" 1234567890123456789 ")
	if err != nil || key != "discord:1234567890123456789" {
		t.Fatalf("BuildDiscordConversationKey() = %q, %v", key, err)
	}
	id, err := ParseDiscordConversationKey(key)
	if err != nil || id != "1234567890123456789" {
		t.Fatalf("ParseDiscordConversationKey() = %q, %v", id, err)
	}
	for _, bad := range []string{"", "abc", "0", "-5", "12 34"} {
		if _, err := BuildDiscordConversationKey(bad); err == nil {
			t.Fatalf("BuildDiscordConversationKey(%q) accepted", bad)
		}
	}
	if _, err := ParseDiscordConversationKey("slack:123"); err == nil {
		t.Fatal("a slack key parsed as discord")
	}
}

func TestBuildConversationKeyRejectsInvalidInput(t *testing.T) {
	cases := []struct {
		name    string
		channel Channel
		id      string
	}{
		{name: "invalid channel", channel: Channel("unknown"), id: "1"},
		{name: "empty id", channel: ChannelTelegram, id: "   "},
		{name: "id contains space", channel: ChannelTelegram, id: "a b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := BuildConversationKey(tc.channel, tc.id); err == nil {
				t.Fatalf("BuildConversationKey() expected error")
			}
		})
	}
}

func TestAccountConversationKeys(t *testing.T) {
	key, err := BuildAccountConversationKey(ChannelWhatsApp, "123", "509")
	if err != nil || key != "whatsapp:123:509" {
		t.Fatalf("key = %q, %v", key, err)
	}
	account, peer, err := ParseAccountConversationKey(ChannelWhatsApp, key)
	if err != nil || account != "123" || peer != "509" {
		t.Fatalf("parse = %q %q %v", account, peer, err)
	}
	if _, err := BuildAccountConversationKey(ChannelWeChat, "bot@im.bot", "user:1"); err == nil {
		t.Fatal("a peer with a colon was accepted")
	}
	if key, err := BuildAccountConversationKey(ChannelWeChat, "bot@im.bot", "o9x@im.wechat"); err != nil || key != "wechat:bot@im.bot:o9x@im.wechat" {
		t.Fatalf("wechat key = %q, %v", key, err)
	}
	for _, bad := range []string{"whatsapp:123", "whatsapp:123:509:9", "wechat:1:2", "whatsapp::509"} {
		if _, _, err := ParseAccountConversationKey(ChannelWhatsApp, bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

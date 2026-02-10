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

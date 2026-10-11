package refid

import "testing"

func TestBlueskyAndXIDs(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"bluesky did", NormalizeBlueskyID("did:plc:abc"), "did.plc.abc"},
		{"bluesky peer form", NormalizeBlueskyID("did.web.example.com"), "did.web.example.com"},
		{"bluesky handle is not an id", NormalizeBlueskyID("alice.bsky.social"), ""},
		{"x id", NormalizeXUserID(" 12345 "), "12345"},
		{"x username is not an id", NormalizeXUserID("@alice"), ""},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, tc.got, tc.want)
		}
	}
	if id, ok := ParseBlueskyUserContactID("bluesky_user:did:plc:abc"); !ok || id != "did.plc.abc" {
		t.Errorf("ParseBlueskyUserContactID = %q, %v", id, ok)
	}
	if id, ok, err := ParseXChatIDHint("x:42"); !ok || err != nil || id != "42" {
		t.Errorf("ParseXChatIDHint = %q, %v, %v", id, ok, err)
	}
	if _, ok, err := ParseBlueskyChatIDHint("bluesky:not-a-did"); !ok || err == nil {
		t.Errorf("ParseBlueskyChatIDHint accepted a non-DID")
	}
}

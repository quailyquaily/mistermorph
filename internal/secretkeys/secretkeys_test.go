package secretkeys

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIsSecretPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"llm.api_key", true},
		{"llm.cloudflare.api_token", true},
		{"llm.profiles.ears.api_key", true},
		{"llm.profiles.chat.bedrock.aws_secret", true},
		{"telegram.bot_token", true},
		{"llm.model", false},
		{"llm.profiles.ears.model", false},
		{"console.password", false},
		{"console.password_hash", false},
		{"server.auth_token", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsSecretPath(tc.path); got != tc.want {
			t.Errorf("IsSecretPath(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

func TestKindAndIdentity(t *testing.T) {
	cases := []struct {
		raw, kind, identity string
	}{
		{"${secret:AAAAAAAAAAAAAAAAAAAAAA}", "os", "os:AAAAAAAAAAAAAAAAAAAAAA"},
		{"${OPENAI_API_KEY}", "env", "env:OPENAI_API_KEY"},
		{"${aws-sm:prod/llm#openai}", "aws", "aws:prod/llm#openai"},
		{"sk-plain-key-value", "file", "file:" + ValueHash("sk-plain-key-value")},
	}
	for _, tc := range cases {
		if got := Kind(tc.raw); got != tc.kind {
			t.Errorf("Kind(%q) = %q, want %q", tc.raw, got, tc.kind)
		}
		if got := Identity(tc.raw); got != tc.identity {
			t.Errorf("Identity(%q) = %q, want %q", tc.raw, got, tc.identity)
		}
	}
	if strings.Contains(Identity("sk-plain-key-value"), "sk-plain") {
		t.Fatal("a plain-text key's identity must not contain the key")
	}
}

func TestHint(t *testing.T) {
	cases := []struct {
		value, want string
	}{
		{"sk-proj-abcdefghijklmnopqrstuvwxyz1234", "sk-proj-…1234"},
		{"xoxb-1234567890-abcdefghijkl", "xoxb-…ijkl"},
		{"123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "1234…Dsaw"},
		{"AKIAIOSFODNN7EXAMPLE", "AKIA…MPLE"},
		{"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJal…EKEY"},
		{"short-password", "…"},
		{"  sk-abcdefghijklmnopqrstu  ", "sk-…rstu"},
	}
	for _, tc := range cases {
		if got := Hint(tc.value); got != tc.want {
			t.Errorf("Hint(%q) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestCollect(t *testing.T) {
	fields := CollectBytes([]byte(`
llm:
  provider: openai
  api_key: "${secret:AAAAAAAAAAAAAAAAAAAAAA}"
  model: gpt-5.5
  profiles:
    ears:
      api_key: "${secret:AAAAAAAAAAAAAAAAAAAAAA}"
      model: whisper-1
    empty:
      api_key: ""
telegram:
  bot_token: plain-token
server:
  auth_token: never-listed
console:
  password: never-listed
`))
	got := map[string]string{}
	for _, field := range fields {
		got[field.Path] = field.Raw
	}
	want := map[string]string{
		"llm.api_key":               "${secret:AAAAAAAAAAAAAAAAAAAAAA}",
		"llm.profiles.ears.api_key": "${secret:AAAAAAAAAAAAAAAAAAAAAA}",
		"telegram.bot_token":        "plain-token",
	}
	if len(got) != len(want) {
		t.Fatalf("Collect() = %v, want %v", got, want)
	}
	for path, raw := range want {
		if got[path] != raw {
			t.Errorf("Collect()[%q] = %q, want %q", path, got[path], raw)
		}
	}
	if CollectBytes([]byte("not: [yaml")) != nil {
		t.Fatal("CollectBytes() of a broken file should have no fields")
	}
}

func TestSync(t *testing.T) {
	path := filepath.Join(t.TempDir(), LedgerFileName)
	day1 := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	day2 := day1.Add(24 * time.Hour)
	chat := Field{Path: "llm.api_key", Raw: "${secret:AAAAAAAAAAAAAAAAAAAAAA}"}
	ears := Field{Path: "llm.profiles.ears.api_key", Raw: "${secret:AAAAAAAAAAAAAAAAAAAAAA}"}
	bot := Field{Path: "telegram.bot_token", Raw: "plain-token"}

	// The first sync starts from the config before the save: those keys have no time, the key the
	// save added has one.
	keys, err := Sync(path, []Field{chat}, []Field{chat, bot}, day1)
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if !keys[Identity(chat.Raw)].At.IsZero() || keys[Identity(chat.Raw)].Path != "llm.api_key" {
		t.Fatalf("baseline key = %#v, want no time", keys[Identity(chat.Raw)])
	}
	if got := keys[Identity(bot.Raw)]; !got.At.Equal(day1) || got.Path != "telegram.bot_token" {
		t.Fatalf("new key = %#v, want saved on day 1 in telegram.bot_token", got)
	}

	// Reusing a key in another field does not change when it was saved.
	keys, err = Sync(path, nil, []Field{chat, ears, bot}, day2)
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if got := keys[Identity(bot.Raw)]; !got.At.Equal(day1) {
		t.Fatalf("reused key = %#v, want day 1 kept", got)
	}

	// A key gone from the config leaves the ledger.
	keys, err = Sync(path, nil, []Field{chat, ears}, day2)
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if _, ok := keys[Identity(bot.Raw)]; ok {
		t.Fatal("a removed key should leave the ledger")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "plain-token") {
		t.Fatal("the ledger must not contain a key")
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("ledger mode = %v, %v; want 0600", info.Mode().Perm(), err)
	}
}

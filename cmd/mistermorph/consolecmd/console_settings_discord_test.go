package consolecmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestConsoleDiscordSettingsRoundTrip(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(configPath, []byte("discord:\n  bot_token: old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	serialized, err := writeConsoleSettings(configPath, consoleSettingsPayload{
		ManagedRuntimes: []string{"discord"},
		Discord: consoleDiscordSettingsPayload{
			BotToken: "token", AllowedGuildIDs: []string{"100"}, AllowedChannelIDs: []string{" 200 ", "200"},
			AllowedUserIDs: []string{"5"}, GroupTriggerMode: "smart",
		},
	})
	if err != nil {
		t.Fatalf("writeConsoleSettings() error = %v", err)
	}
	if err := os.WriteFile(configPath, serialized, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readConsoleSettings(configPath)
	if err != nil {
		t.Fatalf("readConsoleSettings() error = %v", err)
	}
	if len(got.ManagedRuntimes) != 1 || got.ManagedRuntimes[0] != "discord" {
		t.Fatalf("managed runtimes = %#v", got.ManagedRuntimes)
	}
	d := got.Discord
	if d.BotToken != "token" || len(d.AllowedGuildIDs) != 1 || len(d.AllowedChannelIDs) != 1 || d.AllowedChannelIDs[0] != "200" || d.AllowedUserIDs[0] != "5" || d.GroupTriggerMode != "smart" {
		t.Fatalf("discord settings = %#v", d)
	}
}

func TestConsoleDiscordSettingsDefaultToStrictAndCheckIDs(t *testing.T) {
	got, err := normalizeConsoleSettingsPayload(consoleSettingsPayload{Discord: consoleDiscordSettingsPayload{GroupTriggerMode: ""}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Discord.GroupTriggerMode != "strict" {
		t.Fatalf("group trigger mode = %q, want strict", got.Discord.GroupTriggerMode)
	}
	if _, err := normalizeConsoleSettingsPayload(consoleSettingsPayload{Discord: consoleDiscordSettingsPayload{AllowedChannelIDs: []string{"#general"}}}); err == nil || !strings.Contains(err.Error(), "discord.allowed_channel_ids") {
		t.Fatalf("a channel name was accepted: %v", err)
	}
}

func TestConsoleDiscordSettingsHideTheToken(t *testing.T) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte("discord:\n  bot_token: secret\n"), &doc); err != nil {
		t.Fatal(err)
	}
	settings, _, secrets := buildConsoleSettingsResponseView(consoleSettingsPayload{Discord: consoleDiscordSettingsPayload{BotToken: "secret"}}, &doc)
	if settings.Discord.BotToken != "" {
		t.Fatal("the bot token was returned")
	}
	if status, ok := secrets.Discord["bot_token"]; !ok || !status.Configured {
		t.Fatalf("secret status = %#v", secrets.Discord)
	}
}

package channelopts

import (
	"testing"
	"time"
)

func TestBuildDiscordRunOptions(t *testing.T) {
	cfg := DiscordConfigFromReader(stubConfigReader{
		"discord.base_url":                        " https://discord.test/api/v10 ",
		"discord.allowed_guild_ids":               []string{"100", " 100 "},
		"discord.allowed_channel_ids":             []string{"200"},
		"discord.group_trigger_mode":              "strict",
		"discord.record_untriggered":              true,
		"discord.addressing_confidence_threshold": 0.7,
		"discord.max_concurrency":                 5,
		"discord.serve_listen":                    " 127.0.0.1:19993 ",
		"timeout":                                 3 * time.Minute,
	})
	opts := BuildDiscordRunOptions(cfg, DiscordInput{
		BotToken: " token ", AllowedChannelIDs: []string{"201"}, GroupTriggerMode: "smart",
	})
	if opts.BotToken != "token" || opts.BaseURL != "https://discord.test/api/v10" || opts.ServerListen != "127.0.0.1:19993" {
		t.Fatalf("options = %+v", opts)
	}
	if len(opts.AllowedGuildIDs) != 1 || opts.AllowedGuildIDs[0] != "100" {
		t.Fatalf("guilds = %v, want the config value", opts.AllowedGuildIDs)
	}
	if len(opts.AllowedChannelIDs) != 1 || opts.AllowedChannelIDs[0] != "201" {
		t.Fatalf("channels = %v, want the flag value", opts.AllowedChannelIDs)
	}
	if opts.GroupTriggerMode != "smart" || !opts.RecordUntriggered || opts.AddressingConfidenceThreshold != 0.7 {
		t.Fatalf("trigger options = %+v", opts)
	}
	if opts.TaskTimeout != 3*time.Minute || opts.MaxConcurrency != 5 {
		t.Fatalf("timeout=%v concurrency=%d", opts.TaskTimeout, opts.MaxConcurrency)
	}
}

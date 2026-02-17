package telegram

import (
	"testing"
	"time"
)

func TestResolveRuntimeLoopOptionsFromRunOptions(t *testing.T) {
	got := resolveRuntimeLoopOptionsFromRunOptions(RunOptions{
		BotToken:                      " token ",
		AllowedChatIDs:                []int64{1, 1, 2},
		GroupTriggerMode:              "smart",
		AddressingConfidenceThreshold: 0.7,
		AddressingInterjectThreshold:  0.3,
		WithMAEP:                      true,
		MAEPListenAddrs:               []string{" /ip4/1 ", "/ip4/1"},
		PollTimeout:                   45 * time.Second,
		TaskTimeout:                   2 * time.Minute,
		MaxConcurrency:                5,
		FileCacheDir:                  " /tmp/cache ",
		HealthListen:                  "127.0.0.1:8080",
		BusMaxInFlight:                2048,
		RequestTimeout:                75 * time.Second,
		AgentMaxSteps:                 20,
		AgentParseRetries:             4,
		AgentMaxTokenBudget:           1000,
		FileCacheMaxAge:               24 * time.Hour,
		FileCacheMaxFiles:             200,
		FileCacheMaxTotalBytes:        int64(64 * 1024 * 1024),
		HeartbeatEnabled:              true,
		HeartbeatInterval:             15 * time.Minute,
		MemoryEnabled:                 true,
		MemoryShortTermDays:           30,
		MemoryInjectionEnabled:        true,
		MemoryInjectionMaxItems:       10,
		SecretsRequireSkillProfiles:   true,
		MAEPMaxTurnsPerSession:        9,
		MAEPSessionCooldown:           12 * time.Hour,
		InspectPrompt:                 true,
		InspectRequest:                true,
	})
	if got.BotToken != "token" {
		t.Fatalf("bot token = %q, want token", got.BotToken)
	}
	if len(got.AllowedChatIDs) != 2 || got.AllowedChatIDs[0] != 1 || got.AllowedChatIDs[1] != 2 {
		t.Fatalf("allowed chat ids = %#v, want [1 2]", got.AllowedChatIDs)
	}
	if len(got.MAEPListenAddrs) != 1 || got.MAEPListenAddrs[0] != "/ip4/1" {
		t.Fatalf("maep listen addrs = %#v, want [/ip4/1]", got.MAEPListenAddrs)
	}
	if got.BusMaxInFlight != 2048 || got.AgentMaxSteps != 20 || got.FileCacheMaxFiles != 200 {
		t.Fatalf("resolved options mismatch: %#v", got)
	}
	if !got.HeartbeatEnabled || !got.MemoryEnabled || !got.SecretsRequireSkillProfiles {
		t.Fatalf("boolean run options should be preserved: %#v", got)
	}
}

func TestNormalizeRuntimeLoopOptionsDefaults(t *testing.T) {
	got := normalizeRuntimeLoopOptions(runtimeLoopOptions{})
	if got.PollTimeout != 30*time.Second {
		t.Fatalf("poll timeout = %v, want 30s", got.PollTimeout)
	}
	if got.TaskTimeout != 10*time.Minute {
		t.Fatalf("task timeout = %v, want 10m", got.TaskTimeout)
	}
	if got.MaxConcurrency != 3 {
		t.Fatalf("max concurrency = %d, want 3", got.MaxConcurrency)
	}
	if got.BusMaxInFlight != 1024 {
		t.Fatalf("bus max inflight = %d, want 1024", got.BusMaxInFlight)
	}
	if got.RequestTimeout != 90*time.Second {
		t.Fatalf("request timeout = %v, want 90s", got.RequestTimeout)
	}
	if got.AgentMaxSteps != 15 {
		t.Fatalf("agent max steps = %d, want 15", got.AgentMaxSteps)
	}
	if got.AgentParseRetries != 2 {
		t.Fatalf("agent parse retries = %d, want 2", got.AgentParseRetries)
	}
	if got.FileCacheDir != "~/.cache/morph" {
		t.Fatalf("file cache dir = %q, want ~/.cache/morph", got.FileCacheDir)
	}
	if got.FileCacheMaxAge != 7*24*time.Hour {
		t.Fatalf("file cache max age = %v, want 168h", got.FileCacheMaxAge)
	}
	if got.FileCacheMaxFiles != 1000 {
		t.Fatalf("file cache max files = %d, want 1000", got.FileCacheMaxFiles)
	}
	if got.FileCacheMaxTotalBytes != int64(512*1024*1024) {
		t.Fatalf("file cache max total bytes = %d, want 536870912", got.FileCacheMaxTotalBytes)
	}
	if got.HeartbeatInterval != 30*time.Minute {
		t.Fatalf("heartbeat interval = %v, want 30m", got.HeartbeatInterval)
	}
	if got.MemoryShortTermDays != 7 {
		t.Fatalf("memory short term days = %d, want 7", got.MemoryShortTermDays)
	}
	if got.MemoryInjectionMaxItems != 50 {
		t.Fatalf("memory injection max items = %d, want 50", got.MemoryInjectionMaxItems)
	}
	if got.MAEPMaxTurnsPerSession != 6 {
		t.Fatalf("maep max turns per session = %d, want 6", got.MAEPMaxTurnsPerSession)
	}
	if got.MAEPSessionCooldown != 72*time.Hour {
		t.Fatalf("maep session cooldown = %v, want 72h", got.MAEPSessionCooldown)
	}
	if got.GroupTriggerMode != "smart" {
		t.Fatalf("group trigger mode = %q, want smart", got.GroupTriggerMode)
	}
	if got.AddressingConfidenceThreshold != 0.6 {
		t.Fatalf("confidence threshold = %v, want 0.6", got.AddressingConfidenceThreshold)
	}
	if got.AddressingInterjectThreshold != 0.6 {
		t.Fatalf("interject threshold = %v, want 0.6", got.AddressingInterjectThreshold)
	}
}

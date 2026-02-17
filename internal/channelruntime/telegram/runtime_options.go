package telegram

import (
	"strings"
	"time"
)

type runtimeLoopOptions struct {
	BotToken                      string
	AllowedChatIDs                []int64
	GroupTriggerMode              string
	AddressingConfidenceThreshold float64
	AddressingInterjectThreshold  float64
	WithMAEP                      bool
	MAEPListenAddrs               []string
	PollTimeout                   time.Duration
	TaskTimeout                   time.Duration
	MaxConcurrency                int
	FileCacheDir                  string
	HealthListen                  string
	Hooks                         Hooks
	BusMaxInFlight                int
	RequestTimeout                time.Duration
	AgentMaxSteps                 int
	AgentParseRetries             int
	AgentMaxTokenBudget           int
	FileCacheMaxAge               time.Duration
	FileCacheMaxFiles             int
	FileCacheMaxTotalBytes        int64
	HeartbeatEnabled              bool
	HeartbeatInterval             time.Duration
	MemoryEnabled                 bool
	MemoryShortTermDays           int
	MemoryInjectionEnabled        bool
	MemoryInjectionMaxItems       int
	SecretsRequireSkillProfiles   bool
	MAEPMaxTurnsPerSession        int
	MAEPSessionCooldown           time.Duration
	InspectPrompt                 bool
	InspectRequest                bool
}

func resolveRuntimeLoopOptionsFromRunOptions(opts RunOptions) runtimeLoopOptions {
	out := runtimeLoopOptions{
		BotToken:                      strings.TrimSpace(opts.BotToken),
		AllowedChatIDs:                normalizeAllowedChatIDs(opts.AllowedChatIDs),
		GroupTriggerMode:              strings.TrimSpace(opts.GroupTriggerMode),
		AddressingConfidenceThreshold: opts.AddressingConfidenceThreshold,
		AddressingInterjectThreshold:  opts.AddressingInterjectThreshold,
		WithMAEP:                      opts.WithMAEP,
		MAEPListenAddrs:               normalizeRunStringSlice(opts.MAEPListenAddrs),
		PollTimeout:                   opts.PollTimeout,
		TaskTimeout:                   opts.TaskTimeout,
		MaxConcurrency:                opts.MaxConcurrency,
		FileCacheDir:                  strings.TrimSpace(opts.FileCacheDir),
		HealthListen:                  strings.TrimSpace(opts.HealthListen),
		Hooks:                         opts.Hooks,
		BusMaxInFlight:                opts.BusMaxInFlight,
		RequestTimeout:                opts.RequestTimeout,
		AgentMaxSteps:                 opts.AgentMaxSteps,
		AgentParseRetries:             opts.AgentParseRetries,
		AgentMaxTokenBudget:           opts.AgentMaxTokenBudget,
		FileCacheMaxAge:               opts.FileCacheMaxAge,
		FileCacheMaxFiles:             opts.FileCacheMaxFiles,
		FileCacheMaxTotalBytes:        opts.FileCacheMaxTotalBytes,
		HeartbeatEnabled:              opts.HeartbeatEnabled,
		HeartbeatInterval:             opts.HeartbeatInterval,
		MemoryEnabled:                 opts.MemoryEnabled,
		MemoryShortTermDays:           opts.MemoryShortTermDays,
		MemoryInjectionEnabled:        opts.MemoryInjectionEnabled,
		MemoryInjectionMaxItems:       opts.MemoryInjectionMaxItems,
		SecretsRequireSkillProfiles:   opts.SecretsRequireSkillProfiles,
		MAEPMaxTurnsPerSession:        opts.MAEPMaxTurnsPerSession,
		MAEPSessionCooldown:           opts.MAEPSessionCooldown,
		InspectPrompt:                 opts.InspectPrompt,
		InspectRequest:                opts.InspectRequest,
	}
	return normalizeRuntimeLoopOptions(out)
}

func normalizeRuntimeLoopOptions(opts runtimeLoopOptions) runtimeLoopOptions {
	opts.BotToken = strings.TrimSpace(opts.BotToken)
	opts.AllowedChatIDs = normalizeAllowedChatIDs(opts.AllowedChatIDs)
	opts.MAEPListenAddrs = normalizeRunStringSlice(opts.MAEPListenAddrs)
	opts.GroupTriggerMode = strings.ToLower(strings.TrimSpace(opts.GroupTriggerMode))
	opts.FileCacheDir = strings.TrimSpace(opts.FileCacheDir)
	opts.HealthListen = strings.TrimSpace(opts.HealthListen)

	if opts.PollTimeout <= 0 {
		opts.PollTimeout = 30 * time.Second
	}
	if opts.TaskTimeout <= 0 {
		opts.TaskTimeout = 10 * time.Minute
	}
	if opts.MaxConcurrency <= 0 {
		opts.MaxConcurrency = 3
	}
	if opts.BusMaxInFlight <= 0 {
		opts.BusMaxInFlight = 1024
	}
	if opts.RequestTimeout <= 0 {
		opts.RequestTimeout = 90 * time.Second
	}
	if opts.AgentMaxSteps <= 0 {
		opts.AgentMaxSteps = 15
	}
	if opts.AgentParseRetries <= 0 {
		opts.AgentParseRetries = 2
	}
	if opts.FileCacheMaxAge <= 0 {
		opts.FileCacheMaxAge = 7 * 24 * time.Hour
	}
	if opts.FileCacheMaxFiles <= 0 {
		opts.FileCacheMaxFiles = 1000
	}
	if opts.FileCacheMaxTotalBytes <= 0 {
		opts.FileCacheMaxTotalBytes = int64(512 * 1024 * 1024)
	}
	if opts.HeartbeatInterval <= 0 {
		opts.HeartbeatInterval = 30 * time.Minute
	}
	if opts.MemoryShortTermDays <= 0 {
		opts.MemoryShortTermDays = 7
	}
	if opts.MemoryInjectionMaxItems <= 0 {
		opts.MemoryInjectionMaxItems = 50
	}
	if opts.FileCacheDir == "" {
		opts.FileCacheDir = "~/.cache/morph"
	}
	if opts.GroupTriggerMode == "" {
		opts.GroupTriggerMode = "smart"
	}
	if opts.MAEPMaxTurnsPerSession <= 0 {
		opts.MAEPMaxTurnsPerSession = defaultMAEPMaxTurnsPerSession
	}
	if opts.MAEPSessionCooldown <= 0 {
		opts.MAEPSessionCooldown = defaultMAEPSessionCooldown
	}

	opts.AddressingConfidenceThreshold = normalizeAddressingThreshold(opts.AddressingConfidenceThreshold, 0.6)
	opts.AddressingInterjectThreshold = normalizeAddressingThreshold(opts.AddressingInterjectThreshold, 0.6)
	return opts
}

func normalizeAddressingThreshold(v float64, fallback float64) float64 {
	if v <= 0 {
		v = fallback
	}
	if v > 1 {
		v = 1
	}
	return v
}

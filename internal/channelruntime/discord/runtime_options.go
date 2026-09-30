package discord

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

// Group trigger modes. strict is the default: it is the one mode that works without the privileged
// Message Content intent.
const (
	groupTriggerStrict    = "strict"
	groupTriggerSmart     = "smart"
	groupTriggerTalkative = "talkative"
)

// DefaultServerListen is the runtime API address when none is configured.
const DefaultServerListen = "127.0.0.1:8793"

func normalizeRunOptions(opts RunOptions) RunOptions {
	opts.BotToken = strings.TrimSpace(opts.BotToken)
	opts.BaseURL = strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/")
	opts.AllowedGuildIDs = normalizeStrings(opts.AllowedGuildIDs)
	opts.AllowedChannelIDs = normalizeStrings(opts.AllowedChannelIDs)
	opts.AllowedUserIDs = normalizeStrings(opts.AllowedUserIDs)
	opts.GroupTriggerMode = strings.ToLower(strings.TrimSpace(opts.GroupTriggerMode))
	switch opts.GroupTriggerMode {
	case groupTriggerStrict, groupTriggerSmart, groupTriggerTalkative:
	default:
		opts.GroupTriggerMode = groupTriggerStrict
	}
	opts.FileCacheDir = strings.TrimSpace(opts.FileCacheDir)
	opts.ServerListen = strings.TrimSpace(opts.ServerListen)
	opts.ServerAuthToken = strings.TrimSpace(opts.ServerAuthToken)
	if opts.BaseURL == "" {
		opts.BaseURL = discordapi.DefaultAPIBaseURL
	}
	if opts.FileCacheDir == "" {
		opts.FileCacheDir = configdefaults.DefaultFileCacheDir
	}
	opts.FileCacheDir = pathutil.ExpandHomePath(opts.FileCacheDir)
	if opts.TaskTimeout <= 0 {
		opts.TaskTimeout = configdefaults.DefaultTaskTimeout
	}
	if opts.MaxConcurrency <= 0 {
		opts.MaxConcurrency = configdefaults.DefaultChannelMaxConcurrency
	}
	if opts.BusMaxInFlight <= 0 {
		opts.BusMaxInFlight = configdefaults.DefaultBusMaxInFlight
	}
	if opts.ServerMaxQueue <= 0 {
		opts.ServerMaxQueue = configdefaults.DefaultServerMaxQueue
	}
	if opts.RequestTimeout <= 0 {
		opts.RequestTimeout = configdefaults.DefaultLLMRequestTimeout
	}
	opts.AddressingConfidenceThreshold = normalizeThreshold(opts.AddressingConfidenceThreshold, configdefaults.DefaultAddressingThreshold)
	opts.AddressingInterjectThreshold = normalizeThreshold(opts.AddressingInterjectThreshold, configdefaults.DefaultAddressingThreshold)
	opts.AgentLimits = opts.AgentLimits.NormalizeForRuntime()
	if opts.ServerListen == "" && opts.TaskStore == nil {
		opts.ServerListen = DefaultServerListen
	}
	return opts
}

// gatewayIntents asks for message content only when a mode needs to read messages that do not
// mention the bot, because Message Content is a privileged intent.
func gatewayIntents(groupTriggerMode string) int {
	intents := discordapi.IntentGuilds | discordapi.IntentGuildMessages | discordapi.IntentDirectMessages
	if groupTriggerMode != groupTriggerStrict {
		intents |= discordapi.IntentMessageContent
	}
	return intents
}

func normalizeThreshold(value, fallback float64) float64 {
	if value <= 0 || value > 1 {
		return fallback
	}
	return value
}

func normalizeStrings(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

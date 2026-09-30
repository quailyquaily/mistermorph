package channelopts

import (
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	discordruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/discord"
	"github.com/spf13/viper"
)

type DiscordConfig struct {
	BaseURL                              string
	AllowedGuildIDs                      []string
	AllowedChannelIDs                    []string
	AllowedUserIDs                       []string
	DefaultGroupTriggerMode              string
	RecordUntriggered                    bool
	DefaultAddressingConfidenceThreshold float64
	DefaultAddressingInterjectThreshold  float64
	TaskTimeout                          time.Duration
	GlobalTaskTimeout                    time.Duration
	MaxConcurrency                       int
	FileCacheDir                         string
	ServerListen                         string
	ServerAuthToken                      string
	ServerMaxQueue                       int
	BusMaxInFlight                       int
	RequestTimeout                       time.Duration
	AgentLimits                          agent.Limits
	EngineToolsConfig                    agent.EngineToolsConfig
}

type DiscordInput struct {
	BotToken                      string
	AllowedGuildIDs               []string
	AllowedChannelIDs             []string
	AllowedUserIDs                []string
	GroupTriggerMode              string
	AddressingConfidenceThreshold float64
	AddressingInterjectThreshold  float64
	TaskTimeout                   time.Duration
	MaxConcurrency                int
	InspectPrompt                 bool
	InspectRequest                bool
}

func DiscordConfigFromReader(r ConfigReader) DiscordConfig {
	if r == nil {
		return DiscordConfig{}
	}
	return DiscordConfig{
		BaseURL:                              strings.TrimSpace(r.GetString("discord.base_url")),
		AllowedGuildIDs:                      append([]string(nil), r.GetStringSlice("discord.allowed_guild_ids")...),
		AllowedChannelIDs:                    append([]string(nil), r.GetStringSlice("discord.allowed_channel_ids")...),
		AllowedUserIDs:                       append([]string(nil), r.GetStringSlice("discord.allowed_user_ids")...),
		DefaultGroupTriggerMode:              strings.TrimSpace(r.GetString("discord.group_trigger_mode")),
		RecordUntriggered:                    r.GetBool("discord.record_untriggered"),
		DefaultAddressingConfidenceThreshold: r.GetFloat64("discord.addressing_confidence_threshold"),
		DefaultAddressingInterjectThreshold:  r.GetFloat64("discord.addressing_interject_threshold"),
		TaskTimeout:                          r.GetDuration("discord.task_timeout"),
		GlobalTaskTimeout:                    r.GetDuration("timeout"),
		MaxConcurrency:                       r.GetInt("discord.max_concurrency"),
		FileCacheDir:                         strings.TrimSpace(r.GetString("file_cache_dir")),
		ServerListen:                         strings.TrimSpace(r.GetString("discord.serve_listen")),
		ServerAuthToken:                      strings.TrimSpace(r.GetString("server.auth_token")),
		ServerMaxQueue:                       r.GetInt("server.max_queue"),
		BusMaxInFlight:                       r.GetInt("bus.max_inflight"),
		RequestTimeout:                       r.GetDuration("llm.request_timeout"),
		AgentLimits:                          agentLimitsFromReader(r),
		EngineToolsConfig:                    engineToolsConfigFromReader(r),
	}
}

func DiscordConfigFromViper() DiscordConfig {
	return DiscordConfigFromReader(viper.GetViper())
}

// BuildDiscordRunOptions merges command-line input over config: a flag given wins, otherwise the
// config value applies.
func BuildDiscordRunOptions(cfg DiscordConfig, in DiscordInput) discordruntime.RunOptions {
	pick := func(flag, config []string) []string {
		if values := normalizeTrimmedUniqueStrings(flag); len(values) > 0 {
			return values
		}
		return normalizeTrimmedUniqueStrings(config)
	}
	groupTriggerMode := strings.TrimSpace(in.GroupTriggerMode)
	if groupTriggerMode == "" {
		groupTriggerMode = cfg.DefaultGroupTriggerMode
	}
	confidence := in.AddressingConfidenceThreshold
	if confidence <= 0 {
		confidence = cfg.DefaultAddressingConfidenceThreshold
	}
	interject := in.AddressingInterjectThreshold
	if interject <= 0 {
		interject = cfg.DefaultAddressingInterjectThreshold
	}
	taskTimeout := in.TaskTimeout
	if taskTimeout <= 0 {
		taskTimeout = cfg.TaskTimeout
	}
	if taskTimeout <= 0 {
		taskTimeout = cfg.GlobalTaskTimeout
	}
	maxConcurrency := in.MaxConcurrency
	if maxConcurrency <= 0 {
		maxConcurrency = cfg.MaxConcurrency
	}
	return discordruntime.RunOptions{
		BotToken:                      strings.TrimSpace(in.BotToken),
		BaseURL:                       strings.TrimSpace(cfg.BaseURL),
		AllowedGuildIDs:               pick(in.AllowedGuildIDs, cfg.AllowedGuildIDs),
		AllowedChannelIDs:             pick(in.AllowedChannelIDs, cfg.AllowedChannelIDs),
		AllowedUserIDs:                pick(in.AllowedUserIDs, cfg.AllowedUserIDs),
		GroupTriggerMode:              groupTriggerMode,
		RecordUntriggered:             cfg.RecordUntriggered,
		AddressingConfidenceThreshold: confidence,
		AddressingInterjectThreshold:  interject,
		RequestTimeout:                cfg.RequestTimeout,
		TaskTimeout:                   taskTimeout,
		MaxConcurrency:                maxConcurrency,
		FileCacheDir:                  strings.TrimSpace(cfg.FileCacheDir),
		ServerListen:                  strings.TrimSpace(cfg.ServerListen),
		ServerAuthToken:               cfg.ServerAuthToken,
		ServerMaxQueue:                cfg.ServerMaxQueue,
		BusMaxInFlight:                cfg.BusMaxInFlight,
		AgentLimits:                   cfg.AgentLimits,
		EngineToolsConfig:             cfg.EngineToolsConfig,
		InspectPrompt:                 in.InspectPrompt,
		InspectRequest:                in.InspectRequest,
	}
}

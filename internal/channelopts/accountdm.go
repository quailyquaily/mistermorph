package channelopts

import (
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	blueskyruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/bluesky"
	wechatruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/wechat"
	whatsappruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/whatsapp"
	xruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/xchannel"
	"github.com/spf13/viper"
)

// AccountDMConfig is what the account channels (WeChat, WhatsApp, Bluesky, X) read from config,
// besides their credentials.
type AccountDMConfig struct {
	TaskTimeout       time.Duration
	GlobalTaskTimeout time.Duration
	MaxConcurrency    int
	FileCacheDir      string
	ServerListen      string
	ServerAuthToken   string
	ServerMaxQueue    int
	BusMaxInFlight    int
	AgentLimits       agent.Limits
	EngineToolsConfig agent.EngineToolsConfig
}

func accountDMConfigFromReader(r ConfigReader, channel string) AccountDMConfig {
	if r == nil {
		return AccountDMConfig{}
	}
	cfg := AccountDMConfig{
		TaskTimeout:       r.GetDuration(channel + ".task_timeout"),
		GlobalTaskTimeout: r.GetDuration("timeout"),
		MaxConcurrency:    r.GetInt(channel + ".max_concurrency"),
		FileCacheDir:      strings.TrimSpace(r.GetString("file_cache_dir")),
		ServerListen:      strings.TrimSpace(r.GetString(channel + ".serve_listen")),
		ServerAuthToken:   strings.TrimSpace(r.GetString("server.auth_token")),
		ServerMaxQueue:    r.GetInt("server.max_queue"),
		BusMaxInFlight:    r.GetInt("bus.max_inflight"),
		AgentLimits:       agentLimitsFromReader(r),
		EngineToolsConfig: engineToolsConfigFromReader(r),
	}
	return cfg
}

func (cfg AccountDMConfig) engineOptions(inspectPrompt, inspectRequest bool) accountdm.Options {
	taskTimeout := cfg.TaskTimeout
	if taskTimeout <= 0 {
		taskTimeout = cfg.GlobalTaskTimeout
	}
	return accountdm.Options{
		TaskTimeout:       taskTimeout,
		MaxConcurrency:    cfg.MaxConcurrency,
		FileCacheDir:      cfg.FileCacheDir,
		ServerListen:      cfg.ServerListen,
		ServerAuthToken:   cfg.ServerAuthToken,
		ServerMaxQueue:    cfg.ServerMaxQueue,
		BusMaxInFlight:    cfg.BusMaxInFlight,
		AgentLimits:       cfg.AgentLimits,
		EngineToolsConfig: cfg.EngineToolsConfig,
		InspectPrompt:     inspectPrompt,
		InspectRequest:    inspectRequest,
	}
}

type WeChatConfig struct {
	AccountDMConfig
	BotToken string
	BotID    string
	BaseURL  string
}

func WeChatConfigFromReader(r ConfigReader) WeChatConfig {
	if r == nil {
		return WeChatConfig{}
	}
	return WeChatConfig{
		AccountDMConfig: accountDMConfigFromReader(r, "wechat"),
		BotToken:        strings.TrimSpace(r.GetString("wechat.bot_token")),
		BotID:           strings.TrimSpace(r.GetString("wechat.bot_id")),
		BaseURL:         strings.TrimSpace(r.GetString("wechat.base_url")),
	}
}

func WeChatConfigFromViper() WeChatConfig { return WeChatConfigFromReader(viper.GetViper()) }

func BuildWeChatRunOptions(cfg WeChatConfig, runtimeLabel string, inspectPrompt, inspectRequest bool) wechatruntime.RunOptions {
	return wechatruntime.RunOptions{
		Options:      cfg.engineOptions(inspectPrompt, inspectRequest),
		BotToken:     cfg.BotToken,
		BotID:        cfg.BotID,
		BaseURL:      cfg.BaseURL,
		RuntimeLabel: runtimeLabel,
	}
}

type WhatsAppConfig struct {
	AccountDMConfig
	APIToken string
}

func WhatsAppConfigFromReader(r ConfigReader) WhatsAppConfig {
	if r == nil {
		return WhatsAppConfig{}
	}
	return WhatsAppConfig{
		AccountDMConfig: accountDMConfigFromReader(r, "whatsapp"),
		APIToken:        strings.TrimSpace(r.GetString("whatsapp.api_token")),
	}
}

func WhatsAppConfigFromViper() WhatsAppConfig { return WhatsAppConfigFromReader(viper.GetViper()) }

func BuildWhatsAppRunOptions(cfg WhatsAppConfig, runtimeLabel string, inspectPrompt, inspectRequest bool) whatsappruntime.RunOptions {
	return whatsappruntime.RunOptions{
		Options:      cfg.engineOptions(inspectPrompt, inspectRequest),
		APIToken:     cfg.APIToken,
		RuntimeLabel: runtimeLabel,
	}
}

type BlueskyConfig struct {
	AccountDMConfig
	ServiceURL             string
	Identifier             string
	AppPassword            string
	Owners                 []string
	DMEnabled              bool
	DMPollInterval         time.Duration
	DMAllowedUserIDs       []string
	MentionsEnabled        bool
	MentionsPollInterval   time.Duration
	MentionsAllowedUserIDs []string
	MentionsBlockedUserIDs []string
	ThreadContextDepth     int
	MaxReplyPosts          int
}

func BlueskyConfigFromReader(r ConfigReader) BlueskyConfig {
	if r == nil {
		return BlueskyConfig{}
	}
	return BlueskyConfig{
		AccountDMConfig:        accountDMConfigFromReader(r, "bluesky"),
		ServiceURL:             strings.TrimSpace(r.GetString("bluesky.service_url")),
		Identifier:             strings.TrimSpace(r.GetString("bluesky.identifier")),
		AppPassword:            strings.TrimSpace(r.GetString("bluesky.app_password")),
		Owners:                 r.GetStringSlice("bluesky.owners"),
		DMEnabled:              r.GetBool("bluesky.dm.enabled"),
		DMPollInterval:         r.GetDuration("bluesky.dm.poll_interval"),
		DMAllowedUserIDs:       r.GetStringSlice("bluesky.dm.allowed_user_ids"),
		MentionsEnabled:        r.GetBool("bluesky.mentions.enabled"),
		MentionsPollInterval:   r.GetDuration("bluesky.mentions.poll_interval"),
		MentionsAllowedUserIDs: r.GetStringSlice("bluesky.mentions.allowed_user_ids"),
		MentionsBlockedUserIDs: r.GetStringSlice("bluesky.mentions.blocked_user_ids"),
		ThreadContextDepth:     r.GetInt("bluesky.mentions.thread_context_depth"),
		MaxReplyPosts:          r.GetInt("bluesky.mentions.max_reply_posts"),
	}
}

func BlueskyConfigFromViper() BlueskyConfig { return BlueskyConfigFromReader(viper.GetViper()) }

func BuildBlueskyRunOptions(cfg BlueskyConfig, runtimeLabel string, inspectPrompt, inspectRequest bool) blueskyruntime.RunOptions {
	return blueskyruntime.RunOptions{
		Options:     cfg.engineOptions(inspectPrompt, inspectRequest),
		ServiceURL:  cfg.ServiceURL,
		Identifier:  cfg.Identifier,
		AppPassword: cfg.AppPassword,
		Owners:      cfg.Owners,
		DMEnabled:   cfg.DMEnabled, DMPollInterval: cfg.DMPollInterval, DMAllowedUserIDs: cfg.DMAllowedUserIDs,
		MentionsEnabled: cfg.MentionsEnabled, MentionsPollInterval: cfg.MentionsPollInterval,
		MentionsAllowedUserIDs: cfg.MentionsAllowedUserIDs, MentionsBlockedUserIDs: cfg.MentionsBlockedUserIDs,
		ThreadContextDepth: cfg.ThreadContextDepth, MaxReplyPosts: cfg.MaxReplyPosts,
		RuntimeLabel: runtimeLabel,
	}
}

type XConfig struct {
	AccountDMConfig
	ClientID               string
	ClientSecret           string
	RefreshToken           string
	BaseURL                string
	Owners                 []string
	DMEnabled              bool
	DMPollInterval         time.Duration
	DMAllowedUserIDs       []string
	MentionsEnabled        bool
	MentionsPollInterval   time.Duration
	MentionsAllowedUserIDs []string
	MentionsBlockedUserIDs []string
	ThreadContextDepth     int
	MaxReplyPosts          int
	MaxPostsPerDay         int
	AllowLinksInPosts      bool
}

func XConfigFromReader(r ConfigReader) XConfig {
	if r == nil {
		return XConfig{}
	}
	return XConfig{
		AccountDMConfig:        accountDMConfigFromReader(r, "x"),
		ClientID:               strings.TrimSpace(r.GetString("x.client_id")),
		ClientSecret:           strings.TrimSpace(r.GetString("x.client_secret")),
		RefreshToken:           strings.TrimSpace(r.GetString("x.refresh_token")),
		BaseURL:                strings.TrimSpace(r.GetString("x.base_url")),
		Owners:                 r.GetStringSlice("x.owners"),
		DMEnabled:              r.GetBool("x.dm.enabled"),
		DMPollInterval:         r.GetDuration("x.dm.poll_interval"),
		DMAllowedUserIDs:       r.GetStringSlice("x.dm.allowed_user_ids"),
		MentionsEnabled:        r.GetBool("x.mentions.enabled"),
		MentionsPollInterval:   r.GetDuration("x.mentions.poll_interval"),
		MentionsAllowedUserIDs: r.GetStringSlice("x.mentions.allowed_user_ids"),
		MentionsBlockedUserIDs: r.GetStringSlice("x.mentions.blocked_user_ids"),
		ThreadContextDepth:     r.GetInt("x.mentions.thread_context_depth"),
		MaxReplyPosts:          r.GetInt("x.mentions.max_reply_posts"),
		MaxPostsPerDay:         r.GetInt("x.mentions.max_posts_per_day"),
		AllowLinksInPosts:      r.GetBool("x.mentions.allow_links_in_posts"),
	}
}

func XConfigFromViper() XConfig { return XConfigFromReader(viper.GetViper()) }

func BuildXRunOptions(cfg XConfig, runtimeLabel string, inspectPrompt, inspectRequest bool) xruntime.RunOptions {
	return xruntime.RunOptions{
		Options:      cfg.engineOptions(inspectPrompt, inspectRequest),
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		RefreshToken: cfg.RefreshToken,
		BaseURL:      cfg.BaseURL,
		Owners:       cfg.Owners,
		DMEnabled:    cfg.DMEnabled, DMPollInterval: cfg.DMPollInterval, DMAllowedUserIDs: cfg.DMAllowedUserIDs,
		MentionsEnabled: cfg.MentionsEnabled, MentionsPollInterval: cfg.MentionsPollInterval,
		MentionsAllowedUserIDs: cfg.MentionsAllowedUserIDs, MentionsBlockedUserIDs: cfg.MentionsBlockedUserIDs,
		ThreadContextDepth: cfg.ThreadContextDepth, MaxReplyPosts: cfg.MaxReplyPosts,
		MaxPostsPerDay: cfg.MaxPostsPerDay, AllowLinksInPosts: cfg.AllowLinksInPosts,
		RuntimeLabel: runtimeLabel,
	}
}

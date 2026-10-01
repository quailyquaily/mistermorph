package channelopts

import (
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	wechatruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/wechat"
	whatsappruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/whatsapp"
	"github.com/spf13/viper"
)

// AccountDMConfig is what WeChat and WhatsApp read from config, besides their credentials.
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

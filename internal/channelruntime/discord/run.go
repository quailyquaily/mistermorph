// Package discord runs Morph as a Discord bot: it listens on the Gateway, answers DMs and, in
// servers, the messages its group trigger accepts. See docs/feat/feat_20260930_discord_channel.md.
package discord

import (
	"context"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

type HandleModelCommandFunc func(text string) (string, bool, error)
type HandleSkillCommandFunc func(currentLoaded []string) (string, error)

type Dependencies struct {
	depsutil.CommonDependencies
	HandleModelCommand HandleModelCommandFunc
	HandleSkillCommand HandleSkillCommandFunc
}

type RunOptions struct {
	BotToken                      string
	BaseURL                       string
	AllowedGuildIDs               []string
	AllowedChannelIDs             []string
	AllowedUserIDs                []string
	GroupTriggerMode              string
	RecordUntriggered             bool
	AddressingConfidenceThreshold float64
	AddressingInterjectThreshold  float64
	RequestTimeout                time.Duration
	TaskTimeout                   time.Duration
	MaxConcurrency                int
	FileCacheDir                  string
	ServerListen                  string
	ServerAuthToken               string
	ServerMaxQueue                int
	BusMaxInFlight                int
	AgentLimits                   agent.Limits
	EngineToolsConfig             agent.EngineToolsConfig
	InspectPrompt                 bool
	InspectRequest                bool
	TaskStore                     daemonruntime.TaskView
	OnConnectionChange            func(bool)
	// Poke and CronRun are set when the awareness runtime (heartbeat, cron) runs beside the bot.
	Poke    daemonruntime.PokeFunc
	CronRun daemonruntime.CronRunFunc

	// Test seams.
	api     discordAPI
	gateway discordGateway
}

func Run(ctx context.Context, d Dependencies, opts RunOptions) error {
	if err := d.CommonDependencies.Validate(); err != nil {
		return err
	}
	return runDiscordLoop(ctx, d, normalizeRunOptions(opts))
}

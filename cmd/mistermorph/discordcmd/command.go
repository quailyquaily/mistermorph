package discordcmd

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	"github.com/quailyquaily/mistermorph/internal/channelopts"
	awarenessruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	discordruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/discord"
	"github.com/quailyquaily/mistermorph/internal/chatinfo"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

func NewCommand(d Dependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "discord",
		Short: "Run a Discord bot over the Gateway",
		RunE: func(cmd *cobra.Command, args []string) error {
			botToken := strings.TrimSpace(configutil.FlagOrViperString(cmd, "discord-bot-token", "discord.bot_token"))
			if botToken == "" {
				return fmt.Errorf("missing discord.bot_token (set via --discord-bot-token or MISTER_MORPH_DISCORD_BOT_TOKEN)")
			}
			cfg := channelopts.DiscordConfigFromViper()
			hbCfg := channelopts.HeartbeatConfigFromViper()
			cronCfg := channelopts.CronConfigFromViper()
			runtimeToolsConfig := toolsutil.LoadRuntimeToolsRegisterConfigFromViper()
			runOpts := channelopts.BuildDiscordRunOptions(cfg, channelopts.DiscordInput{
				BotToken:                      botToken,
				AllowedGuildIDs:               configutil.FlagOrViperStringArray(cmd, "discord-allowed-guild-id", "discord.allowed_guild_ids"),
				AllowedChannelIDs:             configutil.FlagOrViperStringArray(cmd, "discord-allowed-channel-id", "discord.allowed_channel_ids"),
				AllowedUserIDs:                configutil.FlagOrViperStringArray(cmd, "discord-allowed-user-id", "discord.allowed_user_ids"),
				GroupTriggerMode:              strings.TrimSpace(configutil.FlagOrViperString(cmd, "discord-group-trigger-mode", "discord.group_trigger_mode")),
				AddressingConfidenceThreshold: configutil.FlagOrViperFloat64(cmd, "discord-addressing-confidence-threshold", "discord.addressing_confidence_threshold"),
				AddressingInterjectThreshold:  configutil.FlagOrViperFloat64(cmd, "discord-addressing-interject-threshold", "discord.addressing_interject_threshold"),
				TaskTimeout:                   configutil.FlagOrViperDuration(cmd, "discord-task-timeout", "discord.task_timeout"),
				MaxConcurrency:                configutil.FlagOrViperInt(cmd, "discord-max-concurrency", "discord.max_concurrency"),
				InspectPrompt:                 configutil.FlagOrViperBool(cmd, "inspect-prompt", ""),
				InspectRequest:                configutil.FlagOrViperBool(cmd, "inspect-request", ""),
			})
			deps := buildDiscordRuntimeDeps(d, runtimeToolsConfig, viper.GetViper())
			awarenessEnabled := (hbCfg.Enabled && hbCfg.Interval > 0) || cronCfg.Enabled
			if !awarenessEnabled {
				return discordruntime.Run(cmd.Context(), deps, runOpts)
			}
			awarenessDeps := d.Dependencies
			awarenessDeps.RuntimeToolsConfig = runtimeToolsConfig
			awarenessDeps.RuntimePaths = deps.RuntimePaths
			awarenessDeps.DefaultWorkspaceDir = deps.DefaultWorkspaceDir
			chatInfoOptions := chatinfo.FetcherOptionsFromReader(viper.GetViper())
			chatInfoOptions.DiscordBotToken = botToken
			awarenessOpts := awarenessruntime.RunOptions{
				Interval:          hbCfg.Interval,
				TaskTimeout:       runOpts.TaskTimeout,
				RequestTimeout:    cfg.RequestTimeout,
				AgentLimits:       cfg.AgentLimits,
				EngineToolsConfig: cfg.EngineToolsConfig,
				Source:            "discord",
				ChecklistPath:     deps.RuntimePaths.HeartbeatPath,
				DisableHeartbeat:  !hbCfg.Enabled || hbCfg.Interval <= 0,
				InspectPrompt:     runOpts.InspectPrompt,
				InspectRequest:    runOpts.InspectRequest,
				Notifier:          newDiscordAwarenessNotifier(botToken, runOpts.BaseURL, runOpts.AllowedChannelIDs),
				CronEnabled:       cronCfg.Enabled,
				CronPath:          deps.RuntimePaths.CronPath,
				ChatInfoRefresher: chatinfo.NewFetcher(chatInfoOptions),
			}
			return runDiscordWithAwareness(cmd.Context(), deps, runOpts, awarenessDeps, awarenessOpts)
		},
	}

	cmd.Flags().String("discord-bot-token", "", "Discord bot token.")
	cmd.Flags().StringArray("discord-allowed-guild-id", nil, "Allowed Discord server (guild) id(s). If empty, allows every server the bot is in.")
	cmd.Flags().StringArray("discord-allowed-channel-id", nil, "Allowed Discord channel id(s); a thread is allowed when its parent is. If empty, allows all channels.")
	cmd.Flags().StringArray("discord-allowed-user-id", nil, "Allowed Discord user id(s) for DMs. If empty, allows DMs from anyone.")
	cmd.Flags().String("discord-group-trigger-mode", configdefaults.DefaultDiscordGroupTriggerMode, "Server trigger mode: strict|smart|talkative (smart and talkative need the Message Content intent).")
	cmd.Flags().Float64("discord-addressing-confidence-threshold", configdefaults.DefaultAddressingThreshold, "Minimum confidence (0-1) required to accept an addressing LLM decision.")
	cmd.Flags().Float64("discord-addressing-interject-threshold", configdefaults.DefaultAddressingThreshold, "Minimum interject (0-1) required to accept an addressing LLM decision.")
	cmd.Flags().Duration("discord-task-timeout", 0, "Per-message agent timeout (0 uses --timeout).")
	cmd.Flags().Int("discord-max-concurrency", configdefaults.DefaultChannelMaxConcurrency, "Max number of Discord conversations processed concurrently.")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_discord_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_discord_YYYYMMDD_HHmmss.md.")

	return cmd
}

func buildDiscordRuntimeDeps(d Dependencies, runtimeToolsConfig toolsutil.RuntimeToolsRegisterConfig, reader *viper.Viper) discordruntime.Dependencies {
	return discordruntime.Dependencies{
		CommonDependencies: depsutil.ApplyRuntimeConfig(d.Dependencies, runtimeToolsConfig, reader),
		HandleModelCommand: d.HandleModelCommand,
		HandleSkillCommand: d.HandleSkillCommand,
	}
}

// runDiscordWithAwareness runs the bot and the awareness runtime (heartbeat, cron) together, sharing
// one task store; either ending stops both.
func runDiscordWithAwareness(ctx context.Context, deps discordruntime.Dependencies, runOpts discordruntime.RunOptions, awarenessDeps awarenessruntime.Dependencies, awarenessOpts awarenessruntime.RunOptions) error {
	if runOpts.TaskStore == nil {
		taskStore, err := daemonruntime.NewTaskViewForTarget("discord", runOpts.ServerMaxQueue, daemonruntime.TaskViewConfig{
			PersistenceTargets: deps.TaskPersistenceTargets,
			TasksDir:           deps.RuntimePaths.TasksDir,
			JournalDir:         deps.RuntimePaths.JournalDir,
			RotateMaxBytes:     deps.TaskRotateMaxBytes,
		})
		if err != nil {
			return err
		}
		runOpts.TaskStore = taskStore
		if runOpts.ServerListen == "" {
			runOpts.ServerListen = discordruntime.DefaultServerListen
		}
	}
	attachDiscordAwarenessTriggers(&runOpts, &awarenessOpts)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	errCh := make(chan error, 2)
	go func() { errCh <- discordruntime.Run(runCtx, deps, runOpts) }()
	go func() { errCh <- awarenessruntime.Run(runCtx, awarenessDeps, awarenessOpts) }()
	var firstErr error
	for i := 0; i < 2; i++ {
		err := <-errCh
		if err != nil && !errors.Is(err, context.Canceled) && firstErr == nil {
			firstErr = err
		}
		cancel()
	}
	return firstErr
}

func attachDiscordAwarenessTriggers(runOpts *discordruntime.RunOptions, awarenessOpts *awarenessruntime.RunOptions) {
	awarenessOpts.TaskStore = runOpts.TaskStore
	pokeRequests := make(chan awarenessruntime.PokeRequest)
	awarenessOpts.PokeRequests = pokeRequests
	runOpts.Poke = func(ctx context.Context, input awarenessdomain.PokeInput) error {
		return awarenessruntime.Trigger(ctx, pokeRequests, input)
	}
	if awarenessOpts.CronEnabled {
		cronRequests := make(chan awarenessruntime.CronRequest)
		awarenessOpts.CronRequests = cronRequests
		runOpts.CronRun = func(ctx context.Context, task cronstore.Task) error {
			return awarenessruntime.TriggerCron(ctx, cronRequests, task)
		}
	}
}

// newDiscordAwarenessNotifier sends heartbeat notifications to discord.allowed_channel_ids; with no
// channel listed, heartbeats have nowhere to go and are not sent.
func newDiscordAwarenessNotifier(botToken, baseURL string, channelIDs []string) awarenessruntime.Notifier {
	targets := make([]string, 0, len(channelIDs))
	seen := make(map[string]bool, len(channelIDs))
	for _, raw := range channelIDs {
		channelID := strings.TrimSpace(raw)
		if channelID == "" || seen[channelID] {
			continue
		}
		seen[channelID] = true
		targets = append(targets, channelID)
	}
	if len(targets) == 0 {
		return nil
	}
	client, err := discordapi.NewClient(botToken, discordapi.ClientOptions{BaseURL: baseURL})
	if err != nil {
		return nil
	}
	return awarenessruntime.NotifyFunc(func(ctx context.Context, text string) error {
		parts := discordapi.SplitContent(text, discordapi.MaxMessageLength)
		for _, channelID := range targets {
			for _, part := range parts {
				sendCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				_, err := client.CreateMessage(sendCtx, channelID, discordapi.MessageCreate{Content: part, AllowedMentions: discordapi.NoMentions()})
				cancel()
				if err != nil {
					return err
				}
			}
		}
		return nil
	})
}

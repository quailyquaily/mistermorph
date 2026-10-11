// Package blueskycmd is `morph bluesky`: run a Bluesky account (direct messages and mentions).
package blueskycmd

import (
	"context"
	"strings"

	"github.com/quailyquaily/mistermorph/cmd/mistermorph/accountdmcmd"
	"github.com/quailyquaily/mistermorph/internal/channelopts"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	awarenessruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	blueskyruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/bluesky"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type Dependencies struct {
	awarenessruntime.Dependencies
	HandleModelCommand accountdm.HandleModelCommandFunc
	HandleSkillCommand accountdm.HandleSkillCommandFunc
}

func NewCommand(d Dependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "bluesky",
		Short: "Run a Bluesky account: answer direct messages and public mentions",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := channelopts.BlueskyConfigFromViper()
			if value := strings.TrimSpace(configutil.FlagOrViperString(cmd, "bluesky-identifier", "bluesky.identifier")); value != "" {
				cfg.Identifier = value
			}
			if value := strings.TrimSpace(configutil.FlagOrViperString(cmd, "bluesky-app-password", "bluesky.app_password")); value != "" {
				cfg.AppPassword = value
			}
			if timeout := configutil.FlagOrViperDuration(cmd, "bluesky-task-timeout", "bluesky.task_timeout"); timeout > 0 {
				cfg.TaskTimeout = timeout
			}
			if n := configutil.FlagOrViperInt(cmd, "bluesky-max-concurrency", "bluesky.max_concurrency"); n > 0 {
				cfg.MaxConcurrency = n
			}
			runOpts := channelopts.BuildBlueskyRunOptions(cfg, "morph bluesky",
				configutil.FlagOrViperBool(cmd, "inspect-prompt", ""), configutil.FlagOrViperBool(cmd, "inspect-request", ""))
			runtimeToolsConfig := toolsutil.LoadRuntimeToolsRegisterConfigFromViper()
			deps := accountdm.Dependencies{
				CommonDependencies: depsutil.ApplyRuntimeConfig(d.Dependencies, runtimeToolsConfig, viper.GetViper()),
				HandleModelCommand: d.HandleModelCommand,
				HandleSkillCommand: d.HandleSkillCommand,
			}
			return accountdmcmd.Run(cmd.Context(), "bluesky", d.Dependencies, deps, &runOpts.Options, func(ctx context.Context) error {
				return blueskyruntime.Run(ctx, deps, runOpts)
			})
		},
	}
	cmd.Flags().String("bluesky-identifier", "", "Handle or DID of the agent's Bluesky account.")
	cmd.Flags().String("bluesky-app-password", "", "App password with direct-message access.")
	cmd.Flags().Duration("bluesky-task-timeout", 0, "Per-message agent timeout (0 uses --timeout).")
	cmd.Flags().Int("bluesky-max-concurrency", 0, "Max number of Bluesky conversations processed concurrently.")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_bluesky_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_bluesky_YYYYMMDD_HHmmss.md.")
	return cmd
}

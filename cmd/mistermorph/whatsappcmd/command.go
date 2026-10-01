// Package whatsappcmd is `morph whatsapp`: run a WhatsApp agent.
package whatsappcmd

import (
	"context"

	"strings"

	"github.com/quailyquaily/mistermorph/cmd/mistermorph/accountdmcmd"
	"github.com/quailyquaily/mistermorph/internal/channelopts"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	awarenessruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	whatsappruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/whatsapp"
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
		Use:   "whatsapp",
		Short: "Run a WhatsApp agent (a private chat with its creator, over the Agent Platform)",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := channelopts.WhatsAppConfigFromViper()
			if token := strings.TrimSpace(configutil.FlagOrViperString(cmd, "whatsapp-api-token", "whatsapp.api_token")); token != "" {
				cfg.APIToken = token
			}
			if timeout := configutil.FlagOrViperDuration(cmd, "whatsapp-task-timeout", "whatsapp.task_timeout"); timeout > 0 {
				cfg.TaskTimeout = timeout
			}
			if n := configutil.FlagOrViperInt(cmd, "whatsapp-max-concurrency", "whatsapp.max_concurrency"); n > 0 {
				cfg.MaxConcurrency = n
			}
			runOpts := channelopts.BuildWhatsAppRunOptions(cfg, "morph whatsapp",
				configutil.FlagOrViperBool(cmd, "inspect-prompt", ""), configutil.FlagOrViperBool(cmd, "inspect-request", ""))
			runtimeToolsConfig := toolsutil.LoadRuntimeToolsRegisterConfigFromViper()
			deps := accountdm.Dependencies{
				CommonDependencies: depsutil.ApplyRuntimeConfig(d.Dependencies, runtimeToolsConfig, viper.GetViper()),
				HandleModelCommand: d.HandleModelCommand,
				HandleSkillCommand: d.HandleSkillCommand,
			}
			return accountdmcmd.Run(cmd.Context(), "whatsapp", d.Dependencies, deps, &runOpts.Options, func(ctx context.Context) error {
				return whatsappruntime.Run(ctx, deps, runOpts)
			})
		},
	}
	cmd.Flags().String("whatsapp-api-token", "", "The agent's API key (WhatsApp > Settings > Agents, then Chat info > API key).")
	cmd.Flags().Duration("whatsapp-task-timeout", 0, "Per-message agent timeout (0 uses --timeout).")
	cmd.Flags().Int("whatsapp-max-concurrency", 0, "Max number of WhatsApp conversations processed concurrently.")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_whatsapp_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_whatsapp_YYYYMMDD_HHmmss.md.")
	return cmd
}

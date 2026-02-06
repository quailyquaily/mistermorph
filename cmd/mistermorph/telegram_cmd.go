package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/cmd/telegram"
	"github.com/quailyquaily/mistermorph/internal/heartbeatutil"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/logutil"
	"github.com/quailyquaily/mistermorph/internal/skillsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/memory"
	"github.com/spf13/cobra"
)

func newTelegramCommand() *cobra.Command {
	return telegram.NewCommand(telegram.Dependencies{
		LoggerFromViper:     logutil.LoggerFromViper,
		LogOptionsFromViper: logutil.LogOptionsFromViper,
		CreateLLMClient: func(provider, endpoint, apiKey, model string, timeout time.Duration) (llm.Client, error) {
			return llmutil.ClientFromConfig(llmconfig.ClientConfig{
				Provider:       provider,
				Endpoint:       endpoint,
				APIKey:         apiKey,
				Model:          model,
				RequestTimeout: timeout,
			})
		},
		LLMProviderFromViper:   llmutil.ProviderFromViper,
		LLMEndpointForProvider: llmutil.EndpointForProvider,
		LLMAPIKeyForProvider:   llmutil.APIKeyForProvider,
		LLMModelForProvider:    llmutil.ModelForProvider,
		RegistryFromViper:      registryFromViper,
		RegisterPlanTool:       registerPlanTool,
		GuardFromViper:         guardFromViper,
		PromptSpecForTelegram: func(ctx context.Context, logger *slog.Logger, logOpts agent.LogOptions, task string, client llm.Client, model string, stickySkills []string) (agent.PromptSpec, []string, []string, error) {
			cfg := skillsutil.SkillsConfigFromViper(model)
			if len(stickySkills) > 0 {
				cfg.Requested = append(cfg.Requested, stickySkills...)
			}
			return skillsutil.PromptSpecWithSkills(ctx, logger, logOpts, task, client, model, cfg)
		},
		FormatFinalOutput:  heartbeatutil.FormatFinalOutput,
		BuildHeartbeatTask: heartbeatutil.BuildHeartbeatTask,
		BuildHeartbeatMeta: func(source string, interval time.Duration, checklistPath string, checklistEmpty bool, extra map[string]any) map[string]any {
			return heartbeatutil.BuildHeartbeatMeta(source, interval, checklistPath, checklistEmpty, nil, extra)
		},
		BuildHeartbeatProgressSnapshot: func(mgr *memory.Manager, maxItems int) (string, error) {
			return heartbeatutil.BuildHeartbeatProgressSnapshot(mgr, maxItems)
		},
	})
}

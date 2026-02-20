package slack

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/outputfmt"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type Dependencies struct {
	Logger                 func() (*slog.Logger, error)
	LogOptions             func() agent.LogOptions
	CreateLLMClient        func(provider, endpoint, apiKey, model string, timeout time.Duration) (llm.Client, error)
	LLMProvider            func() string
	LLMEndpointForProvider func(provider string) string
	LLMAPIKeyForProvider   func(provider string) string
	LLMModelForProvider    func(provider string) string
	Registry               func() *tools.Registry
	RegisterPlanTool       func(reg *tools.Registry, client llm.Client, model string)
	Guard                  func(logger *slog.Logger) *guard.Guard
	PromptSpec             func(ctx context.Context, logger *slog.Logger, logOpts agent.LogOptions, task string, client llm.Client, model string, stickySkills []string) (agent.PromptSpec, []string, []string, error)
}

func loggerFromDeps(d Dependencies) (*slog.Logger, error) {
	if d.Logger == nil {
		return nil, fmt.Errorf("Logger dependency missing")
	}
	return d.Logger()
}

func logOptionsFromDeps(d Dependencies) agent.LogOptions {
	if d.LogOptions == nil {
		return agent.LogOptions{}
	}
	return d.LogOptions()
}

func llmProviderFromDeps(d Dependencies) string {
	if d.LLMProvider == nil {
		return ""
	}
	return d.LLMProvider()
}

func llmEndpointForProvider(d Dependencies, provider string) string {
	if d.LLMEndpointForProvider == nil {
		return ""
	}
	return d.LLMEndpointForProvider(provider)
}

func llmAPIKeyForProvider(d Dependencies, provider string) string {
	if d.LLMAPIKeyForProvider == nil {
		return ""
	}
	return d.LLMAPIKeyForProvider(provider)
}

func llmModelForProvider(d Dependencies, provider string) string {
	if d.LLMModelForProvider == nil {
		return ""
	}
	return d.LLMModelForProvider(provider)
}

func llmEndpointFromDeps(d Dependencies) string {
	return llmEndpointForProvider(d, llmProviderFromDeps(d))
}

func llmAPIKeyFromDeps(d Dependencies) string {
	return llmAPIKeyForProvider(d, llmProviderFromDeps(d))
}

func llmModelFromDeps(d Dependencies) string {
	return llmModelForProvider(d, llmProviderFromDeps(d))
}

func llmClientFromConfig(d Dependencies, cfg llmconfig.ClientConfig) (llm.Client, error) {
	if d.CreateLLMClient == nil {
		return nil, fmt.Errorf("CreateLLMClient dependency missing")
	}
	return d.CreateLLMClient(cfg.Provider, cfg.Endpoint, cfg.APIKey, cfg.Model, cfg.RequestTimeout)
}

func registryFromDeps(d Dependencies) *tools.Registry {
	if d.Registry == nil {
		return nil
	}
	return d.Registry()
}

func registerPlanTool(d Dependencies, reg *tools.Registry, client llm.Client, model string) {
	if d.RegisterPlanTool == nil {
		return
	}
	d.RegisterPlanTool(reg, client, model)
}

func guardFromDeps(d Dependencies, log *slog.Logger) *guard.Guard {
	if d.Guard == nil {
		return nil
	}
	return d.Guard(log)
}

func promptSpecForSlack(d Dependencies, ctx context.Context, logger *slog.Logger, logOpts agent.LogOptions, task string, client llm.Client, model string, stickySkills []string) (agent.PromptSpec, []string, []string, error) {
	if d.PromptSpec == nil {
		return agent.PromptSpec{}, nil, nil, fmt.Errorf("PromptSpec dependency missing")
	}
	return d.PromptSpec(ctx, logger, logOpts, task, client, model, stickySkills)
}

func formatFinalOutput(final *agent.Final) string {
	return outputfmt.FormatFinalOutput(final)
}

func formatRuntimeError(err error) string {
	s := strings.TrimSpace(outputfmt.FormatErrorForDisplay(err))
	if s != "" {
		return s
	}
	if err == nil {
		return "unknown error"
	}
	raw := strings.TrimSpace(err.Error())
	if raw == "" {
		return "unknown error"
	}
	return raw
}

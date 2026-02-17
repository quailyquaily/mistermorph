package integration

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// Runtime is the reusable wiring entrypoint for third-party embedding.
type Runtime struct {
	features         Features
	inspect          InspectOptions
	builtinToolNames []string
	snap             runtimeSnapshot
}

type PreparedRun struct {
	Engine  *agent.Engine
	Model   string
	Cleanup func() error
}

func New(cfg Config) *Runtime {
	cfg = normalizeConfig(cfg)
	return &Runtime{
		features:         cfg.Features,
		inspect:          cfg.Inspect,
		builtinToolNames: append([]string(nil), cfg.BuiltinToolNames...),
		snap:             loadRuntimeSnapshot(cfg),
	}
}

func normalizeConfig(cfg Config) Config {
	out := DefaultConfig()
	if cfg.Features != (Features{}) {
		out.Features = cfg.Features
	}
	if cfg.Inspect != (InspectOptions{}) {
		out.Inspect = cfg.Inspect
	}
	if len(cfg.BuiltinToolNames) > 0 {
		out.BuiltinToolNames = normalizeToolNames(cfg.BuiltinToolNames)
	}
	for k, v := range cfg.Overrides {
		key := strings.TrimSpace(k)
		if key == "" {
			continue
		}
		out.Overrides[key] = v
	}
	return out
}

func normalizeToolNames(names []string) []string {
	if len(names) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(names))
	for _, name := range names {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	if len(out) == 0 {
		return nil
	}
	slices.Sort(out)
	return out
}

func (rt *Runtime) NewRegistry() *tools.Registry {
	if rt == nil {
		return tools.NewRegistry()
	}
	snap := rt.snapshot()
	return rt.buildRegistry(snap.Registry, snap.Logger)
}

func (rt *Runtime) NewRunEngine(ctx context.Context, task string) (*PreparedRun, error) {
	return rt.NewRunEngineWithRegistry(ctx, task, nil)
}

func (rt *Runtime) NewRunEngineWithRegistry(ctx context.Context, task string, baseReg *tools.Registry) (*PreparedRun, error) {
	if rt == nil {
		return nil, fmt.Errorf("runtime is nil")
	}
	snap := rt.snapshot()
	if snap.LoggerInitErr != nil {
		return nil, snap.LoggerInitErr
	}
	if ctx == nil {
		ctx = context.Background()
	}
	task = strings.TrimSpace(task)

	logger := snap.Logger
	if logger == nil {
		logger = slog.Default()
	}
	slog.SetDefault(logger)
	logOpts := cloneLogOptions(snap.LogOptions)

	client, err := llmutil.ClientFromConfigWithValues(llmconfig.ClientConfig{
		Provider:       snap.LLMProvider,
		Endpoint:       snap.LLMEndpoint,
		APIKey:         snap.LLMAPIKey,
		Model:          snap.LLMModel,
		RequestTimeout: snap.LLMRequestTimeout,
	}, snap.LLMValues)
	if err != nil {
		return nil, err
	}

	client, inspectCleanup, err := rt.wrapClientWithInspect(client, task, rt.inspect)
	if err != nil {
		return nil, err
	}

	reg := cloneRegistry(baseReg)
	if reg == nil {
		reg = rt.buildRegistry(snap.Registry, logger)
	}

	if rt.features.PlanTool {
		toolsutil.RegisterPlanTool(reg, client, snap.LLMModel)
	}
	toolsutil.BindTodoUpdateToolLLM(reg, client, snap.LLMModel)

	skillAuthProfiles := []string{}
	promptSpec := agent.DefaultPromptSpec()
	if rt.features.Skills {
		spec, _, authProfiles, err := rt.promptSpecWithSkillsFromConfig(ctx, logger, logOpts, task, client, snap.LLMModel, snap.SkillsConfig, nil)
		if err != nil {
			_ = inspectCleanup()
			return nil, err
		}
		promptSpec = spec
		skillAuthProfiles = authProfiles
	}
	promptprofile.ApplyPersonaIdentity(&promptSpec, logger)
	promptprofile.AppendLocalToolNotesBlock(&promptSpec, logger)
	if rt.features.PlanTool {
		promptprofile.AppendPlanCreateGuidanceBlock(&promptSpec, reg)
	}

	opts := []agent.Option{
		agent.WithLogger(logger),
		agent.WithLogOptions(logOpts),
		agent.WithSkillAuthProfiles(skillAuthProfiles, snap.SecretsRequireSkillProfiles),
	}
	if g := rt.buildGuard(snap.Guard, logger); g != nil {
		opts = append(opts, agent.WithGuard(g))
	}

	engine := agent.New(
		client,
		reg,
		agent.Config{
			MaxSteps:       snap.AgentMaxSteps,
			ParseRetries:   snap.AgentParseRetries,
			MaxTokenBudget: snap.AgentMaxTokenBudget,
		},
		promptSpec,
		opts...,
	)

	return &PreparedRun{
		Engine: engine,
		Model:  snap.LLMModel,
		Cleanup: func() error {
			return inspectCleanup()
		},
	}, nil
}

func (rt *Runtime) RunTask(ctx context.Context, task string, opts agent.RunOptions) (*agent.Final, *agent.Context, error) {
	prepared, err := rt.NewRunEngine(ctx, task)
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		_ = prepared.Cleanup()
	}()

	if strings.TrimSpace(opts.Model) == "" {
		opts.Model = prepared.Model
	}
	return prepared.Engine.Run(ctx, task, opts)
}

func cloneRegistry(base *tools.Registry) *tools.Registry {
	if base == nil {
		return nil
	}
	out := tools.NewRegistry()
	for _, t := range base.All() {
		out.Register(t)
	}
	return out
}

func (rt *Runtime) wrapClientWithInspect(client llm.Client, task string, inspect InspectOptions) (llm.Client, func() error, error) {
	if client == nil {
		return nil, func() error { return nil }, fmt.Errorf("llm client is nil")
	}

	closers := make([]func() error, 0, 2)
	cleanup := func() error {
		var firstErr error
		for i := len(closers) - 1; i >= 0; i-- {
			if err := closers[i](); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		return firstErr
	}

	if inspect.Request {
		inspector, err := llminspect.NewRequestInspector(llminspect.Options{
			Mode:            strings.TrimSpace(inspect.Mode),
			Task:            strings.TrimSpace(task),
			TimestampFormat: strings.TrimSpace(inspect.TimestampFormat),
			DumpDir:         strings.TrimSpace(inspect.DumpDir),
		})
		if err != nil {
			return nil, cleanup, err
		}
		closers = append(closers, inspector.Close)
		if err := llminspect.SetDebugHook(client, inspector.Dump); err != nil {
			_ = cleanup()
			return nil, cleanup, err
		}
	}

	if inspect.Prompt {
		inspector, err := llminspect.NewPromptInspector(llminspect.Options{
			Mode:            strings.TrimSpace(inspect.Mode),
			Task:            strings.TrimSpace(task),
			TimestampFormat: strings.TrimSpace(inspect.TimestampFormat),
			DumpDir:         strings.TrimSpace(inspect.DumpDir),
		})
		if err != nil {
			_ = cleanup()
			return nil, cleanup, err
		}
		closers = append(closers, inspector.Close)
		client = &llminspect.PromptClient{Base: client, Inspector: inspector}
	}

	return client, cleanup, nil
}

func (rt *Runtime) RequestTimeout() time.Duration {
	if rt == nil {
		return 0
	}
	return rt.snapshot().LLMRequestTimeout
}

func (rt *Runtime) snapshot() runtimeSnapshot {
	if rt == nil {
		return runtimeSnapshot{}
	}
	return rt.snap
}

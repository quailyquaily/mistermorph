package agent

import (
	"context"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
	"github.com/quailyquaily/mistermorph/tools"
)

type EngineToolsConfig struct {
	SpawnEnabled bool
	CoderEnabled bool
	ToolTriggers map[string]bool
	PathRoots    pathroots.PathRoots
	// CoderEnv builds the environment Codex and Claude Code start in and finds them in it: the
	// bash tool's environment (the PowerShell tool's on Windows) with tools.coder.path_extra in
	// front of its PATH (shellenv.CoderEnvFromConfig).
	CoderEnv shellenv.CoderEnv
	// CoderBypassApprovals names the backends ("codex", "claude", "agy") whose Console sessions start
	// without approval prompts or sandbox. Other runtimes bypass them regardless.
	CoderBypassApprovals map[string]bool
	// WorkerNameSet is the name set (see WorkerNameSets) a task started by this engine names
	// its spawn and coder workers from; empty or unknown means the scientists. Nested runs and
	// resumed tasks keep the set of their task.
	WorkerNameSet string
}

func DefaultEngineToolsConfig() EngineToolsConfig {
	return EngineToolsConfig{
		SpawnEnabled: true,
	}
}

type spawnToolDeps struct {
	LookupTool func(name string) (tools.Tool, bool)
	Runner     SubtaskRunner
}

type coderToolDeps struct {
	Runner      SubtaskRunner
	RunCLI      coderCLIRunFunc
	RunTerminal func(context.Context, CoderRequest) (string, error)
	RunSessions func(context.Context, CoderRequest) (string, error)
	Roots       pathroots.PathRoots
	// Env is EngineToolsConfig.CoderEnv.
	Env shellenv.CoderEnv
	// LookupTool finds a registered tool: the shell tool, for the variables it injects.
	LookupTool func(name string) (tools.Tool, bool)
	// BypassApprovals is EngineToolsConfig.CoderBypassApprovals.
	BypassApprovals map[string]bool
	// Usage gives the recorder of runs' usage and quotas (usage.db); nil records nothing.
	Usage func() *coderusage.Recorder
	// ReadAgyQuota reads the Antigravity CLI's quota after an agy run; nil reads none.
	ReadAgyQuota func(ctx context.Context, coderEnv shellenv.CoderEnv) (coderusage.Quota, error)
}

// registerEngineTools registers the enabled engine tools and returns the prompt blocks that go
// with them.
func registerEngineTools(reg *tools.Registry, cfg EngineToolsConfig, spawnDeps spawnToolDeps, coderDeps coderToolDeps, modelProfiles ModelProfileLister) []PromptBlock {
	if reg == nil {
		return nil
	}
	var blocks []PromptBlock
	if cfg.SpawnEnabled || cfg.ToolTriggers[spawnToolName] {
		if err := reg.Replace(newSpawnTool(spawnDeps)); err != nil {
			panic(err)
		}
		blocks = append(blocks, PromptBlock{Content: subtaskDelegationPromptBlock})
		if modelProfiles != nil {
			if err := reg.Replace(newListModelProfilesTool(modelProfiles)); err != nil {
				panic(err)
			}
			blocks = append(blocks, PromptBlock{Content: modelProfilesPromptBlock})
		}
	}
	if cfg.CoderEnabled || cfg.ToolTriggers[coderToolName] {
		coderDeps.Roots = cfg.PathRoots
		coderDeps.Env = cfg.CoderEnv
		coderDeps.BypassApprovals = cfg.CoderBypassApprovals
		if err := reg.Replace(newCoderTool(coderDeps)); err != nil {
			panic(err)
		}
	}
	return blocks
}

package agent

import (
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/tools"
)

type EngineToolsConfig struct {
	SpawnEnabled   bool
	CoderEnabled   bool
	ToolTriggers   map[string]bool
	PathRoots      pathroots.PathRoots
	CoderPathExtra []string
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
	Runner    SubtaskRunner
	RunCLI    coderCLIRunFunc
	Roots     pathroots.PathRoots
	PathExtra []string
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
		coderDeps.PathExtra = append([]string(nil), cfg.CoderPathExtra...)
		if err := reg.Replace(newCoderTool(coderDeps)); err != nil {
			panic(err)
		}
	}
	return blocks
}

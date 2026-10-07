package agent

import "github.com/quailyquaily/mistermorph/tools"

// EngineTools are the tools an engine registers itself (spawn, coder, codemode, tool_search),
// built without a run. They are for listing names, descriptions and parameter schemas; executing
// them outside an engine fails.
func EngineTools() []tools.Tool {
	return []tools.Tool{
		newSpawnTool(spawnToolDeps{}),
		newCoderTool(coderToolDeps{}),
		&codeModeTool{},
		&toolSearchTool{},
	}
}

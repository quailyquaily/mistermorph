package depsutil

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/mcphost"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestMCPLoader(t *testing.T) {
	if MCPLoader(nil, nil, nil) != nil {
		t.Fatal("loader built without MCP servers")
	}
	servers := []mcphost.ServerStatus{{Config: mcphost.ServerConfig{Name: "github-work", Enable: true}, State: mcphost.ServerInvalid, Err: context.Canceled}}
	load := MCPLoaderFromServers(servers, func(string) map[string]bool { return map[string]bool{"mcp_github-work": true} }, nil)
	closeMCP, err := load(context.Background(), "$mcp_github-work", tools.NewRegistry())
	if err != nil || closeMCP == nil {
		t.Fatalf("a skill of the same name: err = %v, close set = %v; want the skill to win", err, closeMCP != nil)
	}
	load = MCPLoaderFromServers(servers, nil, nil)
	if closeMCP, err := load(context.Background(), "$mcp_github-work", tools.NewRegistry()); err == nil || closeMCP == nil {
		t.Fatalf("invalid server: err = %v; want an error and a usable close", err)
	}
}

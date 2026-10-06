package depsutil

import (
	"context"
	"log/slog"

	"github.com/quailyquaily/mistermorph/internal/mcphost"
	"github.com/quailyquaily/mistermorph/tools"
)

// MCPLoader builds CommonDependencies.LoadReferencedMCP for a runtime's MCP host. skillRefs gives
// the lower-cased skill names a task references; a skill takes precedence over a server of the
// same reference. It returns nil when no MCP servers are configured.
func MCPLoader(host *mcphost.Host, skillRefs func(text string) map[string]bool, logger *slog.Logger) func(context.Context, string, *tools.Registry) (func() error, error) {
	return MCPLoaderFromServers(host.Servers(), skillRefs, logger)
}

// MCPLoaderFromServers is MCPLoader for a runtime that keeps only the servers' startup status.
func MCPLoaderFromServers(servers []mcphost.ServerStatus, skillRefs func(text string) map[string]bool, logger *slog.Logger) func(context.Context, string, *tools.Registry) (func() error, error) {
	if len(servers) == 0 {
		return nil
	}
	return func(ctx context.Context, text string, reg *tools.Registry) (func() error, error) {
		var consumed map[string]bool
		if skillRefs != nil {
			consumed = skillRefs(text)
		}
		taskHost, err := mcphost.LoadReferenced(ctx, text, servers, consumed, reg, logger)
		if err != nil {
			return func() error { return nil }, err
		}
		return taskHost.Close, nil
	}
}

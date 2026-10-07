package taskruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/mcphost"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/tools"
)

// CodeModeOption prepares codemode for one run, or returns nil when tools.codemode is off.
func CodeModeOption(reg *tools.Registry, cfg toolsutil.CodeModeConfig) (agent.Option, error) {
	if !cfg.Enabled || reg == nil {
		return nil, nil
	}
	if cfg.Timeout <= 0 || cfg.MaxToolCalls <= 0 || cfg.MaxParallelCalls <= 0 {
		return nil, fmt.Errorf("tools.codemode.timeout, max_tool_calls and max_parallel_calls must be positive")
	}
	if _, exists := reg.Get("codemode"); exists {
		return nil, fmt.Errorf("a registered tool is named codemode, which Code Mode needs; rename that tool or turn tools.codemode off")
	}
	return agent.WithCodeMode(agent.CodeModeOptions{
		Timeout:          cfg.Timeout,
		MaxToolCalls:     cfg.MaxToolCalls,
		MaxParallelCalls: cfg.MaxParallelCalls,
	}), nil
}

// ToolSearchOption prepares tool search for one run: MCP tools stay hidden until the model finds
// them, except cfg.AlwaysLoaded and visible (tools found earlier in the conversation, and tools of
// servers the task referenced). It returns a nil option when tool search is off or nothing would
// be hidden. The returned close function releases servers the run connected; it is never nil.
func ToolSearchOption(reg *tools.Registry, servers []mcphost.ServerStatus, cfg toolsutil.ToolSearchConfig, visible []string, logger *slog.Logger) (agent.Option, func() error, error) {
	noop := func() error { return nil }
	if !cfg.Enabled || reg == nil {
		return nil, noop, nil
	}
	if _, exists := reg.Get("tool_search"); exists {
		return nil, noop, fmt.Errorf("a registered tool is named tool_search, which tool search needs; rename that tool or turn tools.tool_search off")
	}
	initial := append(append([]string(nil), cfg.AlwaysLoaded...), visible...)
	catalog := newRunToolCatalog(reg, servers, logger)
	if !catalog.hidesSomething(initial) {
		return nil, noop, nil
	}
	return agent.WithToolSearch(agent.ToolSearchOptions{
		Catalog: catalog,
		Hidden:  mcphost.IsTool,
		Visible: initial,
	}), catalog.Close, nil
}

// runToolCatalog is what tool_search reaches for one run: the run registry's MCP tools, and the
// configured servers, which it connects at most once per run and closes with the run.
type runToolCatalog struct {
	reg     *tools.Registry
	servers []mcphost.ServerStatus
	logger  *slog.Logger

	mu    sync.Mutex
	hosts map[string]*mcphost.Host
	tools map[string][]tools.Tool
}

func newRunToolCatalog(reg *tools.Registry, servers []mcphost.ServerStatus, logger *slog.Logger) *runToolCatalog {
	if logger == nil {
		logger = slog.Default()
	}
	return &runToolCatalog{reg: reg, servers: servers, logger: logger, hosts: map[string]*mcphost.Host{}, tools: map[string][]tools.Tool{}}
}

// searchable reports whether search may report or connect a server: enabled, valid, and
// connected at startup, on demand, or failed at startup (which a scoped search retries).
func searchable(status mcphost.ServerStatus) bool {
	if !status.Config.Enable {
		return false
	}
	switch status.State {
	case mcphost.ServerConnected, mcphost.ServerOnDemand, mcphost.ServerFailed:
		return true
	}
	return false
}

func (c *runToolCatalog) status(name string) (mcphost.ServerStatus, bool) {
	key := strings.ToLower(strings.TrimSpace(name))
	for _, status := range c.servers {
		if strings.ToLower(status.Config.Name) == key {
			return status, true
		}
	}
	return mcphost.ServerStatus{}, false
}

func toolPrefix(server string) string {
	return mcphost.NamespacedToolName(server, "")
}

// registryTools are the server's tools the run already has: connected at startup, or loaded
// by a $mcp_<name> reference.
func (c *runToolCatalog) registryTools(server string) []tools.Tool {
	prefix := toolPrefix(server)
	var out []tools.Tool
	for _, tool := range c.reg.All() {
		if mcphost.IsTool(tool) && strings.HasPrefix(tool.Name(), prefix) {
			out = append(out, tool)
		}
	}
	return out
}

func (c *runToolCatalog) hidesSomething(visible []string) bool {
	shown := make(map[string]bool, len(visible))
	for _, name := range visible {
		shown[name] = true
	}
	for _, tool := range c.reg.All() {
		if mcphost.IsTool(tool) && !shown[tool.Name()] {
			return true
		}
	}
	for _, status := range c.servers {
		if searchable(status) && status.State != mcphost.ServerConnected && len(c.registryTools(status.Config.Name)) == 0 {
			return true
		}
	}
	return false
}

func (c *runToolCatalog) Servers() []agent.CatalogServer {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []agent.CatalogServer
	for _, status := range c.servers {
		if !searchable(status) {
			continue
		}
		key := strings.ToLower(status.Config.Name)
		connected := status.State == mcphost.ServerConnected || c.hosts[key] != nil || len(c.registryTools(status.Config.Name)) > 0
		out = append(out, agent.CatalogServer{Name: status.Config.Name, Description: status.Config.Description, Connected: connected})
	}
	return out
}

func (c *runToolCatalog) ConnectServer(ctx context.Context, name string) ([]tools.Tool, error) {
	status, ok := c.status(name)
	if !ok || !status.Config.Enable {
		return nil, fmt.Errorf("mcp server %q is not configured or not enabled", strings.TrimSpace(name))
	}
	if status.State == mcphost.ServerInvalid {
		return nil, fmt.Errorf("mcp server %q: invalid configuration: %w", status.Config.Name, status.Err)
	}
	if !searchable(status) {
		return nil, fmt.Errorf("mcp server %q is not available", status.Config.Name)
	}
	key := strings.ToLower(status.Config.Name)
	c.mu.Lock()
	defer c.mu.Unlock()
	if cached, ok := c.tools[key]; ok {
		return cached, nil
	}
	if existing := c.registryTools(status.Config.Name); len(existing) > 0 {
		c.tools[key] = existing
		return existing, nil
	}
	if status.State == mcphost.ServerConnected {
		return nil, fmt.Errorf("mcp server %q: no allowed tools", status.Config.Name)
	}
	host, err := mcphost.ConnectServers(ctx, []mcphost.ServerConfig{status.Config}, 0, c.logger)
	if err != nil {
		return nil, err
	}
	c.hosts[key] = host
	c.tools[key] = host.Tools()
	c.logger.Info("tool_search_server_connected", "server", status.Config.Name, "count", len(host.Tools()))
	return c.tools[key], nil
}

func (c *runToolCatalog) LoadTools(ctx context.Context, names []string) []tools.Tool {
	byServer := make(map[string][]string)
	var order []string
	for _, name := range names {
		server := c.ServerOfTool(name)
		if server == "" {
			continue
		}
		if _, seen := byServer[server]; !seen {
			order = append(order, server)
		}
		byServer[server] = append(byServer[server], name)
	}
	var out []tools.Tool
	for _, server := range order {
		serverTools, err := c.ConnectServer(ctx, server)
		if err != nil {
			c.logger.Warn("tool_search_tools_unavailable", "server", server, "tools", byServer[server], "error", err.Error())
			continue
		}
		wanted := make(map[string]bool, len(byServer[server]))
		for _, name := range byServer[server] {
			wanted[name] = true
		}
		for _, tool := range serverTools {
			if wanted[tool.Name()] {
				out = append(out, tool)
			}
		}
	}
	return out
}

// ServerOfTool names the searchable server whose tool name prefix is the longest match, since
// server names may themselves contain "__".
func (c *runToolCatalog) ServerOfTool(name string) string {
	best := ""
	for _, status := range c.servers {
		if !searchable(status) {
			continue
		}
		prefix := toolPrefix(status.Config.Name)
		if strings.HasPrefix(name, prefix) && len(prefix) > len(toolPrefix(best)) {
			best = status.Config.Name
		}
	}
	return best
}

// Close releases the servers the run connected. Servers connected at startup are not touched.
func (c *runToolCatalog) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var errs []error
	for _, host := range c.hosts {
		errs = append(errs, host.Close())
	}
	c.hosts = map[string]*mcphost.Host{}
	c.tools = map[string][]tools.Tool{}
	return errors.Join(errs...)
}

package mcphost

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/quailyquaily/mistermorph/tools"
)

// TaskConnectTimeout bounds connecting to one server and listing its tools for a task.
const TaskConnectTimeout = 30 * time.Second

// ConnectServers connects the given servers for one task. Unlike Connect, any failure is an
// error naming the server and the failed step, and closes the servers already connected: the
// task asked for these servers and must not run without them. A server whose allowed tools come
// out empty also fails. timeout bounds each server; zero uses TaskConnectTimeout.
func ConnectServers(ctx context.Context, configs []ServerConfig, timeout time.Duration, logger *slog.Logger) (*Host, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if timeout <= 0 {
		timeout = TaskConnectTimeout
	}
	h := &Host{logger: logger}
	for i := range configs {
		cfg := configs[i]
		session, serverTools, err := h.connectTaskServer(ctx, &cfg, timeout)
		if err != nil {
			logger.Warn("mcp_task_server_failed", "server", cfg.Name, "err", err)
			return nil, errors.Join(err, h.Close())
		}
		h.sessions = append(h.sessions, session)
		h.tools = append(h.tools, serverTools...)
		h.servers = append(h.servers, ServerStatus{Config: cfg, State: ServerConnected})
		logger.Info("mcp_task_server_loaded", "server", cfg.Name, "count", len(serverTools))
	}
	return h, nil
}

func (h *Host) connectTaskServer(ctx context.Context, cfg *ServerConfig, timeout time.Duration) (*mcp.ClientSession, []tools.Tool, error) {
	if err := cfg.Validate(); err != nil {
		return nil, nil, fmt.Errorf("mcp server %q: invalid configuration: %w", cfg.Name, err)
	}
	// When the deadline passes, abort ends the transport, so a server that stops answering cannot
	// hold the connect past it. Once connected, abort is disarmed and kept for Close.
	abortCtx, abort := context.WithCancel(context.Background())
	connectCtx, cancel := context.WithTimeout(ctx, timeout)
	stopAbort := context.AfterFunc(connectCtx, abort)
	session, serverTools, err := h.connectServer(connectCtx, cfg, abortCtx)
	armed := stopAbort()
	cancel()
	if err != nil {
		abort()
		return nil, nil, fmt.Errorf("mcp server %q: %w", cfg.Name, err)
	}
	if !armed {
		// The deadline passed as the connect finished, and the transport is already ended.
		_ = session.Close()
		abort()
		return nil, nil, fmt.Errorf("mcp server %q: connect: %w", cfg.Name, context.DeadlineExceeded)
	}
	if len(serverTools) == 0 {
		_ = session.Close()
		abort()
		return nil, nil, fmt.Errorf("mcp server %q: no allowed tools", cfg.Name)
	}
	h.aborts = append(h.aborts, abort)
	return session, serverTools, nil
}

// LoadReferenced loads the servers that text references with $mcp_<name> for one task, and
// registers their tools in reg, the task's registry. servers is the runtime's startup status:
// a server connected at startup is already in reg and is left alone; an on-demand server, or
// one that failed at startup, is connected for the task; an invalid one fails the task. consumed
// holds the lower-cased names a skill already took. It returns nil when nothing was loaded;
// otherwise the caller closes the returned host when the task's run ends.
func LoadReferenced(ctx context.Context, text string, servers []ServerStatus, consumed map[string]bool, reg *tools.Registry, logger *slog.Logger) (*Host, error) {
	if len(servers) == 0 || reg == nil {
		return nil, nil
	}
	configs := make([]ServerConfig, 0, len(servers))
	statusByName := make(map[string]ServerStatus, len(servers))
	for _, status := range servers {
		configs = append(configs, status.Config)
		key := strings.ToLower(status.Config.Name)
		if previous, seen := statusByName[key]; !seen || previous.State != ServerInvalid {
			statusByName[key] = status
		}
	}
	var toConnect []ServerConfig
	for _, cfg := range ReferencedServers(text, configs, consumed) {
		status := statusByName[strings.ToLower(cfg.Name)]
		switch status.State {
		case ServerConnected:
			continue
		case ServerInvalid:
			return nil, fmt.Errorf("mcp server %q: invalid configuration: %w", cfg.Name, status.Err)
		}
		toConnect = append(toConnect, cfg)
	}
	if len(toConnect) == 0 {
		return nil, nil
	}
	host, err := ConnectServers(ctx, toConnect, 0, logger)
	if err != nil {
		return nil, err
	}
	if err := RegisterHostTools(host, reg); err != nil {
		return nil, fmt.Errorf("mcp servers %s: %w", serverNames(toConnect), err)
	}
	return host, nil
}

func serverNames(configs []ServerConfig) string {
	names := make([]string, 0, len(configs))
	for _, cfg := range configs {
		names = append(names, fmt.Sprintf("%q", cfg.Name))
	}
	return strings.Join(names, ", ")
}

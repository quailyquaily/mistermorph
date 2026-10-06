package mcphost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/quailyquaily/mistermorph/tools"
)

type Host struct {
	mu       sync.Mutex
	sessions []*mcp.ClientSession
	tools    []tools.Tool
	servers  []ServerStatus
	// aborts end task-connected servers' transports on Close.
	aborts []context.CancelFunc
	logger *slog.Logger
}

// ServerState is how a configured server came out of Connect.
type ServerState string

const (
	ServerConnected ServerState = "connected"
	ServerFailed    ServerState = "failed"
	ServerOnDemand  ServerState = "on_demand"
	ServerDisabled  ServerState = "disabled"
	ServerInvalid   ServerState = "invalid"
)

// ServerStatus is one configured server's startup outcome.
type ServerStatus struct {
	Config ServerConfig
	State  ServerState
	// Err is why the server is failed or invalid.
	Err error
}

// Connect creates an MCPHost, connects to all configured MCP servers,
// discovers tools, and returns the host. Individual server failures are
// logged and skipped; Servers reports each server's outcome. On-demand
// servers are not connected here (see ConnectServers).
func Connect(ctx context.Context, configs []ServerConfig, logger *slog.Logger) (*Host, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if len(configs) == 0 {
		return nil, nil
	}

	h := &Host{logger: logger}
	duplicated := duplicatedNames(configs)

	for i := range configs {
		cfg := &configs[i]
		status := ServerStatus{Config: *cfg}
		switch {
		case duplicated[strings.ToLower(cfg.Name)]:
			status.State = ServerInvalid
			status.Err = fmt.Errorf("mcp server name %q is duplicated (names are compared ignoring case)", cfg.Name)
			logger.Warn("mcp_server_config_invalid", "server", cfg.Name, "err", status.Err)
			h.servers = append(h.servers, status)
			continue
		case !cfg.Enable:
			status.State = ServerDisabled
			logger.Info("mcp_server_disabled", "server", cfg.Name)
			h.servers = append(h.servers, status)
			continue
		}
		if err := cfg.Validate(); err != nil {
			status.State, status.Err = ServerInvalid, err
			logger.Warn("mcp_server_config_invalid", "server", cfg.Name, "err", err)
			h.servers = append(h.servers, status)
			continue
		}
		if cfg.OnDemand {
			status.State = ServerOnDemand
			logger.Info("mcp_server_on_demand", "server", cfg.Name)
			h.servers = append(h.servers, status)
			continue
		}

		session, serverTools, err := h.connectServer(ctx, cfg, nil)
		if err != nil {
			status.State, status.Err = ServerFailed, err
			logger.Warn("mcp_server_connect_failed", "server", cfg.Name, "err", err)
			h.servers = append(h.servers, status)
			continue
		}

		status.State = ServerConnected
		h.servers = append(h.servers, status)
		h.sessions = append(h.sessions, session)
		h.tools = append(h.tools, serverTools...)

		toolNames := make([]string, len(serverTools))
		for i, t := range serverTools {
			toolNames[i] = t.Name()
		}
		logger.Info("mcp_tools_loaded",
			"server", cfg.Name,
			"count", len(serverTools),
			"tools", toolNames,
		)
	}

	return h, nil
}

// duplicatedNames returns the lower-cased names that more than one server uses. All of those
// servers are skipped, rather than guessing which one was meant.
func duplicatedNames(configs []ServerConfig) map[string]bool {
	counts := make(map[string]int, len(configs))
	for _, cfg := range configs {
		if name := strings.ToLower(strings.TrimSpace(cfg.Name)); name != "" {
			counts[name]++
		}
	}
	duplicated := make(map[string]bool)
	for name, count := range counts {
		if count > 1 {
			duplicated[name] = true
		}
	}
	return duplicated
}

// Servers returns each configured server's startup outcome, in configuration order.
func (h *Host) Servers() []ServerStatus {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]ServerStatus(nil), h.servers...)
}

// connectServer connects one server and lists its allowed tools. A non-nil abort, when canceled,
// kills the server's process (stdio) or every in-flight request to it (http): ctx alone cannot stop
// the SDK, which sends some requests on a context detached from ctx.
func (h *Host) connectServer(ctx context.Context, cfg *ServerConfig, abort context.Context) (*mcp.ClientSession, []tools.Tool, error) {
	client := mcp.NewClient(
		&mcp.Implementation{Name: "mistermorph", Version: "1.0"},
		nil,
	)

	transport, err := h.buildTransport(cfg, abort)
	if err != nil {
		return nil, nil, err
	}

	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("connect: %w", err)
	}

	toolsList, err := session.ListTools(ctx, nil)
	if err != nil {
		_ = session.Close()
		return nil, nil, fmt.Errorf("list tools: %w", err)
	}

	allowedSet := cfg.AllowedToolSet()

	var adapted []tools.Tool
	for _, t := range toolsList.Tools {
		if allowedSet != nil && !allowedSet[t.Name] {
			continue
		}
		adapter, err := newToolAdapter(cfg.Name, t, session)
		if err != nil {
			h.logger.Warn("mcp_tool_adapt_failed",
				"server", cfg.Name,
				"tool", t.Name,
				"err", err,
			)
			continue
		}
		adapted = append(adapted, adapter)
	}

	return session, adapted, nil
}

func (h *Host) buildTransport(cfg *ServerConfig, abort context.Context) (mcp.Transport, error) {
	typ := strings.ToLower(strings.TrimSpace(cfg.Type))
	if typ == "" {
		typ = "stdio"
	}

	switch typ {
	case "stdio":
		return h.buildStdioTransport(cfg, abort), nil
	case "http":
		return h.buildHTTPTransport(cfg, abort), nil
	default:
		return nil, fmt.Errorf("unsupported type: %s", typ)
	}
}

func (h *Host) buildStdioTransport(cfg *ServerConfig, abort context.Context) mcp.Transport {
	cmd := exec.Command(cfg.Command, cfg.Args...)
	if abort != nil {
		cmd = exec.CommandContext(abort, cfg.Command, cfg.Args...)
	}
	if len(cfg.Env) > 0 {
		cmd.Env = os.Environ()
		for k, v := range cfg.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	return &mcp.CommandTransport{Command: cmd}
}

func (h *Host) buildHTTPTransport(cfg *ServerConfig, abort context.Context) mcp.Transport {
	transport := &mcp.StreamableClientTransport{
		Endpoint: cfg.URL,
	}

	var roundTripper http.RoundTripper
	if len(cfg.Headers) > 0 {
		roundTripper = &headerInjector{base: http.DefaultTransport, headers: cfg.Headers}
	}
	if abort != nil {
		base := roundTripper
		if base == nil {
			base = http.DefaultTransport
		}
		roundTripper = &abortableTransport{base: base, abort: abort}
	}
	if roundTripper != nil {
		transport.HTTPClient = &http.Client{Transport: roundTripper}
	}

	return transport
}

// abortableTransport ends every request, including one still reading its body, once abort is
// canceled.
type abortableTransport struct {
	base  http.RoundTripper
	abort context.Context
}

func (t *abortableTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithCancel(req.Context())
	stop := context.AfterFunc(t.abort, cancel)
	resp, err := t.base.RoundTrip(req.WithContext(ctx))
	if err != nil {
		stop()
		cancel()
		return nil, err
	}
	resp.Body = &releasingBody{ReadCloser: resp.Body, release: func() { stop(); cancel() }}
	return resp, nil
}

// releasingBody releases a request's abort watch when its body is closed.
type releasingBody struct {
	io.ReadCloser
	release func()
}

func (b *releasingBody) Close() error {
	err := b.ReadCloser.Close()
	b.release()
	return err
}

// Tools returns all adapted MCP tools.
func (h *Host) Tools() []tools.Tool {
	if h == nil {
		return nil
	}
	return h.tools
}

// Close gracefully closes all MCP sessions.
func (h *Host) Close() error {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	var firstErr error
	for _, session := range h.sessions {
		if err := session.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	for _, abort := range h.aborts {
		abort()
	}
	h.sessions = nil
	h.tools = nil
	h.aborts = nil
	return firstErr
}

// RegisterTools connects to all configured MCP servers and registers
// discovered tools into reg. Returns the host (for cleanup) or nil if
// no MCP servers are configured.
func RegisterTools(ctx context.Context, configs []ServerConfig, reg *tools.Registry, logger *slog.Logger) (*Host, error) {
	if len(configs) == 0 {
		return nil, nil
	}
	host, err := Connect(ctx, configs, logger)
	if err != nil {
		return nil, err
	}
	if host == nil {
		return nil, nil
	}
	if err := RegisterHostTools(host, reg); err != nil {
		return nil, err
	}
	return host, nil
}

// RegisterHostTools installs a connected host's tools as one rollback-safe batch.
// A failed registration closes the host and removes tools already added by this call.
func RegisterHostTools(host *Host, reg *tools.Registry) error {
	if host == nil {
		return nil
	}
	registeredNames := make([]string, 0, len(host.Tools()))
	for _, tool := range host.Tools() {
		if err := reg.Register(tool); err != nil {
			for _, name := range registeredNames {
				reg.Remove(name)
			}
			closeErr := host.Close()
			return errors.Join(fmt.Errorf("register MCP tool: %w", err), closeErr)
		}
		registeredNames = append(registeredNames, tool.Name())
	}
	return nil
}

// headerInjector is an http.RoundTripper that injects custom headers.
type headerInjector struct {
	base    http.RoundTripper
	headers map[string]string
}

func (h *headerInjector) RoundTrip(req *http.Request) (*http.Response, error) {
	for k, v := range h.headers {
		req.Header.Set(k, v)
	}
	return h.base.RoundTrip(req)
}

package consolecmd

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentlink"
	"github.com/quailyquaily/mistermorph/internal/personautil"
)

const (
	agentLinkRetryMin = time.Second
	agentLinkRetryMax = 5 * time.Minute
	// agentLinkStableAfter is how long a connection must last before a reconnect starts from the
	// shortest delay again.
	agentLinkStableAfter = 30 * time.Second
)

// agentLinkSupervisor keeps the Console's Agent Link relay connected to its own runtime and to
// every remote endpoint.
type agentLinkSupervisor struct {
	relay  *agentlink.Relay
	node   *agentlink.Node
	logger *slog.Logger

	mu    sync.Mutex
	links map[string]context.CancelFunc
	wg    *sync.WaitGroup
}

// newAgentLinkSupervisor returns nil when Agent Link is off for this Console.
func newAgentLinkSupervisor(s *server) *agentLinkSupervisor {
	if s == nil || s.localRuntime == nil || strings.TrimSpace(s.cfg.stateDir) == "" {
		return nil
	}
	reader := s.localRuntime.currentConfigReader()
	if reader != nil && !reader.GetBool("contacts.agent_link.enabled") {
		return nil
	}
	logger := s.localRuntime.currentLogger()
	stateDir := s.cfg.stateDir
	opts := agentlink.Options{
		StateDir:  stateDir,
		Logger:    logger,
		AgentName: func() string { return personautil.LoadAgentName(stateDir) },
	}
	if reader != nil {
		opts.QueueTTL = reader.GetDuration("contacts.agent_link.queue_ttl")
	}
	node, err := agentlink.Shared(opts)
	if err != nil {
		logger.Warn("agentlink_unavailable", "error", err.Error())
		return nil
	}
	return &agentLinkSupervisor{
		relay:  agentlink.NewRelay(logger),
		node:   node,
		logger: logger.With("component", "agentlink_console"),
		links:  make(map[string]context.CancelFunc),
		wg:     &s.endpointWorkersWG,
	}
}

// start connects the Console's own runtime to the relay until ctx ends.
func (a *agentLinkSupervisor) start(ctx context.Context) {
	if a == nil {
		return
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		for ctx.Err() == nil {
			local, console := agentlink.Pipe()
			linkCtx, cancel := context.WithCancel(ctx)
			go func() {
				_ = a.node.Serve(linkCtx, local)
				cancel()
			}()
			if err := a.relay.Serve(linkCtx, console, consoleLocalEndpointRef); err != nil && ctx.Err() == nil {
				a.logger.Warn("agentlink_local_link_error", "error", err.Error())
			}
			cancel()
			if !sleepContext(ctx, agentLinkRetryMin) {
				return
			}
		}
	}()
}

// sync connects the relay to each remote endpoint and drops endpoints that are gone.
func (a *agentLinkSupervisor) sync(ctx context.Context, endpoints []runtimeEndpoint) {
	if a == nil || ctx.Err() != nil {
		return
	}
	type target struct{ name, url, token string }
	wanted := make(map[string]target)
	for _, endpoint := range endpoints {
		client, ok := endpoint.Client.(*daemonTaskClient)
		if !ok || client.baseURL == "" || client.authToken == "" {
			continue
		}
		wanted[client.baseURL+"\n"+client.authToken] = target{name: endpoint.Name, url: client.baseURL, token: client.authToken}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, cancel := range a.links {
		if _, ok := wanted[key]; !ok {
			cancel()
			delete(a.links, key)
		}
	}
	for key, t := range wanted {
		if _, ok := a.links[key]; ok {
			continue
		}
		linkCtx, cancel := context.WithCancel(ctx)
		a.links[key] = cancel
		a.wg.Add(1)
		go func(t target) {
			defer a.wg.Done()
			a.runRemote(linkCtx, t.name, t.url, t.token)
		}(t)
	}
}

func (a *agentLinkSupervisor) runRemote(ctx context.Context, name, url, token string) {
	delay := agentLinkRetryMin
	for ctx.Err() == nil {
		conn, err := agentlink.Dial(ctx, url, token)
		if err != nil {
			a.logger.Debug("agentlink_dial_error", "endpoint", name, "error", err.Error())
		} else {
			startedAt := time.Now()
			err = a.relay.Serve(ctx, conn, name)
			if errors.Is(err, agentlink.ErrDuplicateInstance) {
				a.logger.Warn("agentlink_endpoint_duplicate", "endpoint", name, "error", err.Error())
				delay = agentLinkRetryMax
			} else if time.Since(startedAt) >= agentLinkStableAfter {
				delay = agentLinkRetryMin
			}
		}
		if !sleepContext(ctx, delay) {
			return
		}
		delay *= 2
		if delay > agentLinkRetryMax {
			delay = agentLinkRetryMax
		}
	}
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

package daemonruntime

import (
	"net/http"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentlink"
	"github.com/quailyquaily/mistermorph/internal/personautil"
)

// registerAgentLinkRoutes serves the Agent Link stream a Console connects to. Every runtime API
// sharing a state dir in this process serves the same node.
func (routes *routeRegistration) registerAgentLinkRoutes() {
	reader := routes.settingsReader
	if reader != nil && !reader.GetBool("contacts.agent_link.enabled") {
		return
	}
	stateDir := strings.TrimSpace(routes.paths.StateDir)
	if stateDir == "" || strings.TrimSpace(routes.authToken) == "" {
		return
	}
	opts := agentlink.Options{StateDir: stateDir, AgentName: routes.agentName}
	if reader != nil {
		opts.QueueTTL = reader.GetDuration("contacts.agent_link.queue_ttl")
	}
	node, err := agentlink.Shared(opts)
	if err != nil {
		return
	}
	authToken := routes.authToken
	routes.mux.Handle(agentlink.WebSocketPath, node.WebSocketHandler(func(r *http.Request) bool {
		return checkAuth(r, authToken)
	}))
}

func (routes *routeRegistration) agentName() string {
	if routes.options.AgentNameFunc != nil {
		return strings.TrimSpace(routes.options.AgentNameFunc())
	}
	if name := strings.TrimSpace(routes.options.AgentName); name != "" {
		return name
	}
	return personautil.LoadAgentName(routes.paths.StateDir)
}

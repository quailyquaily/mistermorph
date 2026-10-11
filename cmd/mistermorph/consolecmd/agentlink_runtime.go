package consolecmd

import (
	agentlinkruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/agentlink"
)

// reloadAgentLinkRunner restarts the runner that answers Agent Link messages, on the current
// generation's configuration.
func (r *consoleLocalRuntime) reloadAgentLinkRunner() {
	if r == nil {
		return
	}
	r.stopAgentLinkRunner()
	r.awarenessMu.Lock()
	workersCtx := r.workersCtx
	r.awarenessMu.Unlock()
	if workersCtx == nil {
		return
	}
	generation, err := r.captureGeneration()
	if err != nil {
		return
	}
	reader := generation.reader
	if !canSubmitGeneration(generation) || reader == nil || !reader.GetBool("contacts.agent_link.enabled") {
		generation.release()
		return
	}
	stop := agentlinkruntime.Start(workersCtx, generation.commonDeps, agentlinkruntime.Options{
		TaskTimeout:       consoleDefaultTimeoutFromReader(reader),
		AgentLimits:       consoleAgentLimitsFromReader(reader),
		EngineToolsConfig: consoleEngineToolsConfigFromReader(reader),
		MaxHops:           reader.GetInt("contacts.agent_link.max_hops"),
		QueueTTL:          reader.GetDuration("contacts.agent_link.queue_ttl"),
		InactiveAfter:     reader.GetDuration("contacts.agent_link.inactive_after"),
		TaskStore:         r.store,
	})
	r.awarenessMu.Lock()
	r.agentLinkStop = func() {
		stop()
		generation.release()
	}
	r.awarenessMu.Unlock()
}

func (r *consoleLocalRuntime) stopAgentLinkRunner() {
	if r == nil {
		return
	}
	r.awarenessMu.Lock()
	stop := r.agentLinkStop
	r.agentLinkStop = nil
	r.awarenessMu.Unlock()
	if stop != nil {
		stop()
	}
}

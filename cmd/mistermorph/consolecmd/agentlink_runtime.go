package consolecmd

import (
	"context"
	"fmt"
	"strings"

	agentlinkruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/agentlink"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
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
		LateReply:         r.deliverAgentLinkLateReply,
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

// deliverAgentLinkLateReply brings an agent's answer that came after agent_send stopped waiting into
// the Console topic that asked: into its run if one is going, or else as a new task in it.
func (r *consoleLocalRuntime) deliverAgentLinkLateReply(ctx context.Context, reply agentlinkruntime.LateReply) error {
	if reply.Origin.Runtime != "console" || strings.TrimSpace(reply.Origin.TopicID) == "" {
		return fmt.Errorf("the answer was not asked for from a Console topic")
	}
	topicID := strings.TrimSpace(reply.Origin.TopicID)
	peer := strings.TrimSpace(reply.PeerName)
	if peer == "" {
		peer = reply.ContactID
	}
	task := fmt.Sprintf("[Agent Link] %s (%s) answered the message you sent it:\n\n%s", peer, reply.ContactID, strings.TrimSpace(reply.Message.Envelope.Text))
	if result := r.trySteerConsoleRun(task, topicID); result.Found {
		return nil
	}
	generation, err := r.captureGeneration()
	if err != nil {
		return err
	}
	timeout := configdefaults.DefaultTaskTimeout
	if generation.reader != nil {
		timeout = consoleDefaultTimeoutFromReader(generation.reader)
	}
	_, ownershipTransferred, err := r.submitTaskViaBus(ctx, generation, task, "", "", timeout,
		topicID, "", "", nil, daemonruntime.TaskTrigger{Source: "agentlink", Event: "reply", Ref: reply.Message.MessageID})
	if !ownershipTransferred {
		generation.release()
	}
	return err
}

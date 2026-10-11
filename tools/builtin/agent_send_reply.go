package builtin

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/agentlink"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
)

// Streams of the tool_output events agent_send emits for an Agent Link exchange; the Console shows
// them in the chat as the messages between the agents.
const (
	AgentLinkStreamSent    = "agentlink_sent"
	AgentLinkStreamReply   = "agentlink_reply"
	AgentLinkStreamPending = "agentlink_pending"
)

// agentLinkAsk is an agent_send over Agent Link, which waits for the other agent's answer.
type agentLinkAsk struct {
	toolName  string
	node      *agentlink.Node
	contactID string
	peer      string
	messageID string
	replies   <-chan agentlink.Message
	stop      func()
}

// agentLinkInstanceFor returns the agent a send to contact with chatID goes to, when it goes over
// Agent Link and this process runs a node for stateDir.
func agentLinkInstanceFor(stateDir string, contact contacts.Contact, chatID string) (*agentlink.Node, string, bool) {
	if strings.TrimSpace(stateDir) == "" {
		return nil, "", false
	}
	channel, err := contacts.ResolveDecisionChannel(contact, contacts.ShareDecision{ContactID: contact.ContactID, ChatID: chatID})
	if err != nil || channel != contacts.ChannelAgentLink {
		return nil, "", false
	}
	instanceID, ok := contacts.AgentLinkInstanceID(chatID)
	if !ok {
		instanceID, ok = contacts.AgentLinkInstanceID(contact.ContactID)
	}
	if !ok {
		return nil, "", false
	}
	node, ok := agentlink.Lookup(stateDir)
	if !ok {
		return nil, "", false
	}
	return node, instanceID, true
}

// agentLinkSessionParams gives params the session ID of this conversation's dialogue with the agent,
// unless they name one, so the agent keeps follow-up questions in the same conversation.
func agentLinkSessionParams(ctx context.Context, params map[string]any, node *agentlink.Node, instanceID string) map[string]any {
	if session, _ := params["session_id"].(string); strings.TrimSpace(session) != "" {
		return params
	}
	scope, _ := topiccontext.ScopeFromContext(ctx)
	session := node.SessionFor(scope.ConversationKey, instanceID)
	if session == "" {
		return params
	}
	out := make(map[string]any, len(params)+1)
	for key, value := range params {
		out[key] = value
	}
	out["session_id"] = session
	return out
}

// skipsAgentSendCooldown reports whether an agent_send to contact may skip the cooldown: an Agent
// Link exchange a person's task started waits for each answer, so it cannot run away; the task's
// own limits bound it.
func (p contactSendExecutionPolicy) skipsAgentSendCooldown(ctx context.Context, contact contacts.Contact, chatID string) bool {
	if !p.waitForReplies || agentlink.IncomingHop(ctx) > 0 {
		return false
	}
	_, _, ok := agentLinkInstanceFor(p.stateDir, contact, chatID)
	return ok
}

// expectAgentLinkReply registers for the answer to decision before it is sent, when the policy waits
// for answers and the send goes over Agent Link. It returns nil otherwise.
func expectAgentLinkReply(ctx context.Context, policy contactSendExecutionPolicy, contact contacts.Contact, decision contacts.ShareDecision) *agentLinkAsk {
	if !policy.waitForReplies {
		return nil
	}
	node, instanceID, ok := agentLinkInstanceFor(policy.stateDir, contact, decision.ChatID)
	if !ok {
		return nil
	}
	scope, _ := topiccontext.ScopeFromContext(ctx)
	replies, stop := node.ExpectReply(decision.ItemID, instanceID, agentlink.Origin{
		Runtime: scope.Runtime, ConversationKey: scope.ConversationKey, TopicID: scope.TopicID,
	})
	peer := strings.TrimSpace(contact.ContactNickname)
	if peer == "" {
		peer = strings.TrimSpace(contact.ContactID)
	}
	return &agentLinkAsk{
		toolName: policy.toolName, node: node, contactID: contact.ContactID, peer: peer,
		messageID: decision.ItemID, replies: replies, stop: stop,
	}
}

// abandon is for a send that failed: no answer will come.
func (a *agentLinkAsk) abandon() {
	if a == nil {
		return
	}
	a.stop()
	a.node.ForgetAsk(a.messageID)
}

// sent shows the message in the chat.
func (a *agentLinkAsk) sent(ctx context.Context, text string) {
	a.emit(ctx, AgentLinkStreamSent, text)
}

func (a *agentLinkAsk) emit(ctx context.Context, stream, text string) {
	agent.EmitEvent(ctx, nil, agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: a.toolName,
		Stream:   stream,
		Summary:  a.peer,
		Text:     text,
		Status:   "running",
	})
}

// wait waits for the answer until deadline and returns what the tool reports about it.
func (a *agentLinkAsk) wait(ctx context.Context, deadline time.Time) map[string]any {
	defer a.stop()
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case msg := <-a.replies:
		text := strings.TrimSpace(msg.Envelope.Text)
		a.emit(ctx, AgentLinkStreamReply, text)
		return map[string]any{
			"status":     "replied",
			"from":       a.peer,
			"contact_id": a.contactID,
			"message_id": msg.MessageID,
			"text":       text,
		}
	case <-timer.C:
	case <-ctx.Done():
	}
	a.emit(ctx, AgentLinkStreamPending, "")
	return map[string]any{
		"status": "pending",
		"from":   a.peer,
		"note":   "No answer yet. It arrives in this conversation as a new message when it comes; do not send the question again.",
	}
}

// waitAgentLinkReplies waits for every ask's answer, up to timeout in all, and returns them in order.
func waitAgentLinkReplies(ctx context.Context, asks []*agentLinkAsk, timeout time.Duration) []map[string]any {
	out := make([]map[string]any, len(asks))
	deadline := time.Now().Add(timeout)
	var wg sync.WaitGroup
	for i, ask := range asks {
		if ask == nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = ask.wait(ctx, deadline)
		}()
	}
	wg.Wait()
	return out
}

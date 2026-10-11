package agentlink

import (
	"fmt"
	"strings"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
)

// Channel is the Agent Link channel name, and ContactPrefix starts the contact ID of every agent on
// it: mm:<instance_id>.
const (
	Channel       = "agentlink"
	ContactPrefix = "mm:"
)

// WebSocketPath is the runtime API route a Console connects to.
const WebSocketPath = "/agentlink/ws"

// Frame types.
const (
	FrameHello         = "hello"
	FrameRoster        = "roster"
	FrameSend          = "send"
	FrameSendResult    = "send_result"
	FrameDeliver       = "deliver"
	FrameDeliverResult = "deliver_result"
	FramePing          = "ping"
	FramePong          = "pong"
	FrameError         = "error"
)

// Delivery statuses.
const (
	// StatusDelivered: the target accepted the message.
	StatusDelivered = "delivered"
	// StatusQueued: the message waits in the sender's queue for a Console that reaches the target.
	StatusQueued = "queued"
	// StatusRejected: the target refused the message; it is not retried.
	StatusRejected = "rejected"
	// StatusUnreachable: the Console could not reach the target; the message is queued again.
	StatusUnreachable = "unreachable"
	// StatusAccepted: the target saved the message (deliver_result only).
	StatusAccepted = "accepted"
	// StatusExpired: the message stayed undelivered past the queue TTL.
	StatusExpired = "expired"
)

// Rejection reasons.
const (
	ReasonHopLimit   = "hop_limit"
	ReasonNoHandler  = "no_handler"
	ReasonRateLimit  = "rate_limited"
	ReasonInvalid    = "invalid_message"
	ReasonDuplicate  = "duplicate_instance_id"
	ReasonHandlerErr = "handler_error"
)

// Peer is one agent on Agent Link.
type Peer struct {
	InstanceID string `json:"instance_id"`
	AgentName  string `json:"agent_name,omitempty"`
}

// ContactID is the peer's contact ID.
func (p Peer) ContactID() string { return ContactID(p.InstanceID) }

// Message is one Agent Link message. Hop counts how many agents relayed the conversation to this
// point: a message a human-started task sends has hop 1, and each reply chain adds one.
type Message struct {
	MessageID string                     `json:"message_id"`
	From      string                     `json:"from"`
	To        string                     `json:"to"`
	Hop       int                        `json:"hop"`
	Envelope  busruntime.MessageEnvelope `json:"envelope"`
}

// Validate checks the fields every message needs.
func (m Message) Validate() error {
	if strings.TrimSpace(m.MessageID) == "" {
		return fmt.Errorf("message_id is required")
	}
	if !ValidInstanceID(m.From) {
		return fmt.Errorf("invalid from %q", m.From)
	}
	if !ValidInstanceID(m.To) {
		return fmt.Errorf("invalid to %q", m.To)
	}
	if m.Hop < 1 {
		return fmt.Errorf("hop must be at least 1")
	}
	if strings.TrimSpace(m.Envelope.Text) == "" {
		return fmt.Errorf("text is required")
	}
	return nil
}

// Frame is one WebSocket frame between a runtime and a Console.
type Frame struct {
	Type       string   `json:"type"`
	InstanceID string   `json:"instance_id,omitempty"`
	AgentName  string   `json:"agent_name,omitempty"`
	Agents     []Peer   `json:"agents,omitempty"`
	LeaseID    string   `json:"lease_id,omitempty"`
	MessageID  string   `json:"message_id,omitempty"`
	Status     string   `json:"status,omitempty"`
	Reason     string   `json:"reason,omitempty"`
	Message    *Message `json:"message,omitempty"`
}

// ContactID returns the contact ID of the agent with instanceID.
func ContactID(instanceID string) string {
	return ContactPrefix + strings.TrimSpace(instanceID)
}

// InstanceIDFromContactID returns the instance ID in an Agent Link contact ID.
func InstanceIDFromContactID(contactID string) (string, bool) {
	contactID = strings.TrimSpace(contactID)
	if !strings.HasPrefix(strings.ToLower(contactID), ContactPrefix) {
		return "", false
	}
	id := strings.TrimSpace(contactID[len(ContactPrefix):])
	if !ValidInstanceID(id) {
		return "", false
	}
	return id, true
}

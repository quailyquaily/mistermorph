package contactsruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/agentlink"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
)

// agentLinkSendWait is how long a send waits for delivery before reporting the message as queued.
const agentLinkSendWait = 10 * time.Second

func (s *RoutingSender) sendAgentLink(ctx context.Context, contact contacts.Contact, decision contacts.ShareDecision) (bool, bool, error) {
	instanceID, ok := contacts.AgentLinkInstanceID(decision.ChatID)
	if !ok {
		instanceID, ok = contacts.AgentLinkInstanceID(contact.ContactID)
	}
	if !ok {
		return false, false, fmt.Errorf("contact %s is not an Agent Link agent", contact.ContactID)
	}
	node, ok := agentlink.Lookup(s.agentLinkStateDir)
	if !ok || s.agentLinkStateDir == "" {
		return false, false, fmt.Errorf("agent link is not running in this process")
	}
	raw, err := buildEnvelopePayload(decision, decision.ContentType, decision.PayloadBase64, time.Now().UTC())
	if err != nil {
		return false, false, err
	}
	var envelope busruntime.MessageEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return false, false, fmt.Errorf("decode envelope payload: %w", err)
	}
	result, err := node.Send(ctx, instanceID, envelope, agentlink.OutgoingHop(ctx), agentLinkSendWait)
	if err != nil {
		return false, false, err
	}
	switch result.Status {
	case agentlink.StatusDelivered:
		return true, false, nil
	case agentlink.StatusQueued:
		return false, false, &contacts.QueuedDeliveryError{MessageID: result.MessageID}
	default:
		reason := strings.TrimSpace(result.Reason)
		if reason == "" {
			reason = result.Status
		}
		return false, false, fmt.Errorf("agent link %s: %s", result.Status, reason)
	}
}

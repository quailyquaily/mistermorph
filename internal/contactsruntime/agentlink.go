package contactsruntime

import (
	"context"
	"encoding/base64"
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
	var envelope busruntime.MessageEnvelope
	if decision.File != nil {
		// A file's caption may be empty, which the text envelope does not allow.
		envelope, err := agentLinkFileEnvelope(decision, time.Now().UTC())
		if err != nil {
			return false, false, err
		}
		return s.sendAgentLinkEnvelope(ctx, node, instanceID, decision, envelope)
	}
	raw, err := buildEnvelopePayload(decision, decision.ContentType, decision.PayloadBase64, time.Now().UTC())
	if err != nil {
		return false, false, err
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return false, false, fmt.Errorf("decode envelope payload: %w", err)
	}
	return s.sendAgentLinkEnvelope(ctx, node, instanceID, decision, envelope)
}

// agentLinkFileEnvelope is the envelope of a file decision: its optional caption, session and
// reply_to.
func agentLinkFileEnvelope(decision contacts.ShareDecision, now time.Time) (busruntime.MessageEnvelope, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(decision.PayloadBase64))
	if err != nil {
		return busruntime.MessageEnvelope{}, fmt.Errorf("decode payload_base64: %w", err)
	}
	var payload struct {
		Text      string `json:"text"`
		SessionID string `json:"session_id"`
		ReplyTo   string `json:"reply_to"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return busruntime.MessageEnvelope{}, fmt.Errorf("decode message envelope: %w", err)
	}
	sessionID := strings.TrimSpace(payload.SessionID)
	if sessionID == "" {
		return busruntime.MessageEnvelope{}, fmt.Errorf("session_id is required for dialogue topics")
	}
	if err := validateSessionID(sessionID); err != nil {
		return busruntime.MessageEnvelope{}, err
	}
	return busruntime.MessageEnvelope{
		MessageID: strings.TrimSpace(decision.ItemID),
		Text:      strings.TrimSpace(payload.Text),
		SentAt:    now.Format(time.RFC3339),
		SessionID: sessionID,
		ReplyTo:   strings.TrimSpace(payload.ReplyTo),
	}, nil
}

func (s *RoutingSender) sendAgentLinkEnvelope(ctx context.Context, node *agentlink.Node, instanceID string, decision contacts.ShareDecision, envelope busruntime.MessageEnvelope) (bool, bool, error) {
	var attachments []agentlink.Attachment
	if decision.File != nil {
		attachment, err := readAgentLinkAttachment(decision)
		if err != nil {
			return false, false, err
		}
		attachments = []agentlink.Attachment{attachment}
	}
	result, err := node.SendWithAttachments(ctx, instanceID, envelope, attachments, agentlink.OutgoingHop(ctx), agentLinkSendWait)
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
		if reason == agentlink.ReasonFilesUnsupported {
			return false, false, fmt.Errorf("agent link %s: %s: %w", result.Status, reason, agentlink.ErrFilesUnsupported)
		}
		return false, false, fmt.Errorf("agent link %s: %s", result.Status, reason)
	}
}

// readAgentLinkAttachment checks the decision's file again and returns it as an attachment that
// names it; the node copies it into its queue, checking its size and SHA-256 once more, and the
// route's limit applies there. The display name is the one the tool resolved, before sanitizing.
func readAgentLinkAttachment(decision contacts.ShareDecision) (agentlink.Attachment, error) {
	file, _, err := prepareFileSend(decision, agentlink.MaxStreamAttachmentBytes)
	if err != nil {
		return agentlink.Attachment{}, err
	}
	name := strings.TrimSpace(file.DisplayName)
	if name == "" {
		name = file.Filename
	}
	return agentlink.OpenAttachmentFile(file.Path, name, file.Size, file.SHA256)
}

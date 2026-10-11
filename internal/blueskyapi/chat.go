package blueskyapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ProfileBasic is the part of a profile the channel shows.
type ProfileBasic struct {
	DID         string  `json:"did"`
	Handle      string  `json:"handle"`
	DisplayName string  `json:"displayName,omitempty"`
	Labels      []Label `json:"labels,omitempty"`
	Associated  *struct {
		Chat *struct {
			AllowIncoming string `json:"allowIncoming,omitempty"`
		} `json:"chat,omitempty"`
	} `json:"associated,omitempty"`
}

// Label is a label on a profile or post; a "bot" self-label marks an automated account.
type Label struct {
	Src string `json:"src"`
	Val string `json:"val"`
}

// IsBot reports whether the profile labels itself an automated account.
func (p ProfileBasic) IsBot() bool {
	for _, label := range p.Labels {
		if strings.EqualFold(label.Val, "bot") && strings.EqualFold(label.Src, p.DID) {
			return true
		}
	}
	return false
}

// Name is the display name, or the handle without one.
func (p ProfileBasic) Name() string {
	return firstNonEmpty(p.DisplayName, p.Handle, p.DID)
}

// Convo is a direct-message conversation.
type Convo struct {
	ID          string            `json:"id"`
	Rev         string            `json:"rev"`
	Members     []ProfileBasic    `json:"members"`
	Status      string            `json:"status,omitempty"`
	UnreadCount int               `json:"unreadCount"`
	Muted       bool              `json:"muted"`
	Kind        *json.RawMessage  `json:"kind,omitempty"`
	LastMessage *MessageOrDeleted `json:"lastMessage,omitempty"`
}

// IsGroup reports a group conversation; the channel handles direct ones only.
func (c Convo) IsGroup() bool {
	if c.Kind == nil {
		return false
	}
	var kind struct {
		Type string `json:"$type"`
	}
	_ = json.Unmarshal(*c.Kind, &kind)
	return strings.HasSuffix(kind.Type, "#groupConvo")
}

// Other returns the member who is not self.
func (c Convo) Other(self string) (ProfileBasic, bool) {
	for _, member := range c.Members {
		if member.DID != self {
			return member, true
		}
	}
	return ProfileBasic{}, false
}

// Message is a message in a conversation.
type Message struct {
	Type    string          `json:"$type,omitempty"`
	ID      string          `json:"id"`
	Rev     string          `json:"rev"`
	Text    string          `json:"text"`
	Facets  []Facet         `json:"facets,omitempty"`
	Embed   json.RawMessage `json:"embed,omitempty"`
	ReplyTo *struct {
		MessageID string `json:"messageId"`
	} `json:"replyTo,omitempty"`
	Sender struct {
		DID string `json:"did"`
	} `json:"sender"`
	SentAt string `json:"sentAt"`
}

// MessageOrDeleted is one item of a message list: a message, a deleted one, or a system message.
type MessageOrDeleted = Message

// IsText reports a message view, not a deleted or system message.
func (m Message) IsText() bool {
	return m.Type == "" || strings.HasSuffix(m.Type, "#messageView")
}

// Time is when the message was sent.
func (m Message) Time() time.Time {
	at, _ := time.Parse(time.RFC3339Nano, strings.TrimSpace(m.SentAt))
	return at
}

// ListConvos lists conversations, with unread ones only when unreadOnly.
func (c *Client) ListConvos(ctx context.Context, cursor string, unreadOnly bool) ([]Convo, string, error) {
	params := url.Values{"limit": {"50"}, "kind": {"direct"}}
	if cursor != "" {
		params.Set("cursor", cursor)
	}
	if unreadOnly {
		params.Set("readState", "unread")
	}
	var out struct {
		Convos []Convo `json:"convos"`
		Cursor string  `json:"cursor"`
	}
	err := c.xrpc(ctx, http.MethodGet, "chat.bsky.convo.listConvos", params, nil, &out, ChatProxy)
	return out.Convos, out.Cursor, err
}

// ListConvoRequests lists conversations people started that the account has not accepted yet.
func (c *Client) ListConvoRequests(ctx context.Context, cursor string) ([]Convo, string, error) {
	params := url.Values{"limit": {"50"}}
	if cursor != "" {
		params.Set("cursor", cursor)
	}
	var out struct {
		Requests []json.RawMessage `json:"requests"`
		Cursor   string            `json:"cursor"`
	}
	if err := c.xrpc(ctx, http.MethodGet, "chat.bsky.convo.listConvoRequests", params, nil, &out, ChatProxy); err != nil {
		return nil, "", err
	}
	convos := make([]Convo, 0, len(out.Requests))
	for _, raw := range out.Requests {
		var item struct {
			Type string `json:"$type"`
		}
		_ = json.Unmarshal(raw, &item)
		if item.Type != "" && !strings.HasSuffix(item.Type, "#convoView") {
			continue
		}
		var convo Convo
		if json.Unmarshal(raw, &convo) == nil && convo.ID != "" {
			convos = append(convos, convo)
		}
	}
	return convos, out.Cursor, nil
}

// GetMessages returns a conversation's latest messages.
func (c *Client) GetMessages(ctx context.Context, convoID string, limit int) ([]Message, error) {
	params := url.Values{"convoId": {convoID}, "limit": {strconv.Itoa(min(max(limit, 1), 100))}}
	var out struct {
		Messages []Message `json:"messages"`
	}
	err := c.xrpc(ctx, http.MethodGet, "chat.bsky.convo.getMessages", params, nil, &out, ChatProxy)
	return out.Messages, err
}

// GetConvoForMembers finds or opens the direct conversation with did.
func (c *Client) GetConvoForMembers(ctx context.Context, did string) (Convo, error) {
	params := url.Values{"members": {did}}
	var out struct {
		Convo Convo `json:"convo"`
	}
	err := c.xrpc(ctx, http.MethodGet, "chat.bsky.convo.getConvoForMembers", params, nil, &out, ChatProxy)
	return out.Convo, err
}

// SendMessage sends text to a conversation, as a reply to replyTo when it is set.
func (c *Client) SendMessage(ctx context.Context, convoID, text string, facets []Facet, replyTo string) (Message, error) {
	message := map[string]any{"text": text}
	if len(facets) > 0 {
		message["facets"] = facets
	}
	if replyTo != "" {
		message["replyTo"] = map[string]string{"messageId": replyTo}
	}
	var out Message
	err := c.xrpc(ctx, http.MethodPost, "chat.bsky.convo.sendMessage", nil, map[string]any{"convoId": convoID, "message": message}, &out, ChatProxy)
	return out, err
}

// UpdateRead marks a conversation read up to messageID.
func (c *Client) UpdateRead(ctx context.Context, convoID, messageID string) error {
	body := map[string]string{"convoId": convoID}
	if messageID != "" {
		body["messageId"] = messageID
	}
	return c.xrpc(ctx, http.MethodPost, "chat.bsky.convo.updateRead", nil, body, nil, ChatProxy)
}

// AcceptConvo accepts a conversation request.
func (c *Client) AcceptConvo(ctx context.Context, convoID string) error {
	return c.xrpc(ctx, http.MethodPost, "chat.bsky.convo.acceptConvo", nil, map[string]string{"convoId": convoID}, nil, ChatProxy)
}

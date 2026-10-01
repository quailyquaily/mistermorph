package wechatapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Message types and states.
const (
	MessageTypeUser = 1
	MessageTypeBot  = 2

	MessageStateFinish = 2

	ItemText  = 1
	ItemImage = 2
	ItemVoice = 3
	ItemFile  = 4
	ItemVideo = 5
)

// Message is one WeChat message. Numeric IDs stay json.Number so they are never rounded through a
// float64.
type Message struct {
	Seq          json.Number `json:"seq,omitempty"`
	MessageID    json.Number `json:"message_id,omitempty"`
	FromUserID   string      `json:"from_user_id,omitempty"`
	ToUserID     string      `json:"to_user_id,omitempty"`
	ClientID     string      `json:"client_id,omitempty"`
	CreateTimeMs json.Number `json:"create_time_ms,omitempty"`
	SessionID    string      `json:"session_id,omitempty"`
	GroupID      string      `json:"group_id,omitempty"`
	MessageType  int         `json:"message_type,omitempty"`
	MessageState int         `json:"message_state,omitempty"`
	ItemList     []Item      `json:"item_list,omitempty"`
	ContextToken string      `json:"context_token,omitempty"`
}

type Item struct {
	Type      int         `json:"type"`
	TextItem  *TextItem   `json:"text_item,omitempty"`
	VoiceItem *VoiceItem  `json:"voice_item,omitempty"`
	RefMsg    *RefMessage `json:"ref_msg,omitempty"`
	ImageItem *ImageItem  `json:"image_item,omitempty"`
	FileItem  *FileItem   `json:"file_item,omitempty"`
	VideoItem *VideoItem  `json:"video_item,omitempty"`
}

type TextItem struct {
	Text string `json:"text"`
}

// VoiceItem may carry the server's transcript of a voice message.
type VoiceItem struct {
	Media *CDNMedia `json:"media,omitempty"`
	Text  string    `json:"text,omitempty"`
}

// ImageItem's AESKey, when set, is the key in hex and takes precedence over Media.AESKey.
type ImageItem struct {
	Media  *CDNMedia `json:"media,omitempty"`
	AESKey string    `json:"aeskey,omitempty"`
}

type FileItem struct {
	Media    *CDNMedia `json:"media,omitempty"`
	FileName string    `json:"file_name,omitempty"`
	Len      string    `json:"len,omitempty"`
}

type VideoItem struct {
	Media *CDNMedia `json:"media,omitempty"`
}

// RefMessage is the message a reply quotes.
type RefMessage struct {
	Title       string `json:"title,omitempty"`
	MessageItem *Item  `json:"message_item,omitempty"`
}

// ID is the message's ID as a string: message_id, or seq when there is none.
func (m Message) ID() string {
	if id := strings.TrimSpace(m.MessageID.String()); id != "" && id != "0" {
		return id
	}
	return strings.TrimSpace(m.Seq.String())
}

// SentAt is when the message was created, or zero.
func (m Message) SentAt() time.Time {
	ms, err := m.CreateTimeMs.Int64()
	if err != nil || ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

// Text is the message's words: its text items, and the transcript of voice items.
func (m Message) Text() string {
	var parts []string
	for _, item := range m.ItemList {
		switch item.Type {
		case ItemText:
			if item.TextItem != nil && strings.TrimSpace(item.TextItem.Text) != "" {
				parts = append(parts, strings.TrimSpace(item.TextItem.Text))
			}
		case ItemVoice:
			if item.VoiceItem != nil && strings.TrimSpace(item.VoiceItem.Text) != "" {
				parts = append(parts, strings.TrimSpace(item.VoiceItem.Text))
			}
		}
	}
	return strings.Join(parts, "\n")
}

// QuotedText is the text of the message this one quotes, when it quotes one.
func (m Message) QuotedText() string {
	for _, item := range m.ItemList {
		if item.RefMsg == nil {
			continue
		}
		if ref := item.RefMsg.MessageItem; ref != nil && ref.TextItem != nil && strings.TrimSpace(ref.TextItem.Text) != "" {
			return strings.TrimSpace(ref.TextItem.Text)
		}
		if title := strings.TrimSpace(item.RefMsg.Title); title != "" {
			return title
		}
	}
	return ""
}

// HasMedia reports whether the message carries media other than a transcribed voice message,
// including media that cannot be downloaded.
func (m Message) HasMedia() bool {
	for _, item := range m.ItemList {
		switch item.Type {
		case ItemImage, ItemFile, ItemVideo:
			return true
		case ItemVoice:
			if item.VoiceItem == nil || strings.TrimSpace(item.VoiceItem.Text) == "" {
				return true
			}
		}
	}
	return false
}

// Updates is one getupdates response. Buf is the cursor for the next call; empty means keep the
// current one.
type Updates struct {
	Messages        []Message
	Buf             string
	LongPollTimeout time.Duration
}

// GetUpdates long-polls for messages after cursor buf ("" to start). A long poll that ends without
// messages, by the server or by the client timeout, is an empty result, not an error.
func (c *Client) GetUpdates(ctx context.Context, buf string, timeout time.Duration) (Updates, error) {
	if timeout <= 0 {
		timeout = longPollTimeout
	}
	var resp struct {
		result
		Msgs            []Message `json:"msgs"`
		GetUpdatesBuf   string    `json:"get_updates_buf"`
		LongPollingTime int64     `json:"longpolling_timeout_ms"`
	}
	body := map[string]any{"get_updates_buf": buf, "base_info": c.baseInfo()}
	err := c.post(ctx, "getupdates", "/ilink/bot/getupdates", body, true, timeout+5*time.Second, &resp)
	if err != nil {
		if ctx.Err() == nil && isTimeout(err) {
			return Updates{}, nil
		}
		return Updates{}, err
	}
	if err := resp.err("getupdates"); err != nil {
		return Updates{}, err
	}
	out := Updates{Messages: resp.Msgs, Buf: resp.GetUpdatesBuf}
	if resp.LongPollingTime > 0 {
		out.LongPollTimeout = time.Duration(resp.LongPollingTime) * time.Millisecond
	}
	return out, nil
}

// SendText sends a finished text message to a user, as a reply in the conversation contextToken
// names. The returned client ID identifies the send; the server is not known to deduplicate it.
func (c *Client) SendText(ctx context.Context, toUserID, contextToken, text string) (string, error) {
	toUserID = strings.TrimSpace(toUserID)
	text = strings.TrimSpace(text)
	if toUserID == "" || text == "" {
		return "", fmt.Errorf("wechat sendmessage: recipient and text are required")
	}
	return c.sendItem(ctx, toUserID, contextToken, map[string]any{"type": ItemText, "text_item": map[string]string{"text": text}})
}

// sendItem sends one finished item; WeChat takes one item per message.
func (c *Client) sendItem(ctx context.Context, toUserID, contextToken string, item map[string]any) (string, error) {
	toUserID = strings.TrimSpace(toUserID)
	if toUserID == "" {
		return "", fmt.Errorf("wechat sendmessage: recipient is required")
	}
	if strings.TrimSpace(contextToken) == "" {
		return "", fmt.Errorf("%w for %s; WeChat replies need a recent message from the user", ErrNoContext, toUserID)
	}
	clientID := newClientID()
	msg := map[string]any{
		"from_user_id":  "",
		"to_user_id":    toUserID,
		"client_id":     clientID,
		"message_type":  MessageTypeBot,
		"message_state": MessageStateFinish,
		"context_token": contextToken,
		"item_list":     []map[string]any{item},
	}
	var resp result
	if err := c.post(ctx, "sendmessage", "/ilink/bot/sendmessage", map[string]any{"msg": msg, "base_info": c.baseInfo()}, true, apiTimeout, &resp); err != nil {
		return clientID, err
	}
	return clientID, resp.err("sendmessage")
}

// ErrNoContext means there is no conversation context to reply in: the user has not written since
// the runtime started.
var ErrNoContext = errors.New("wechat sendmessage: no conversation context")

// TypingTicket gets the ticket SendTyping needs for a user.
func (c *Client) TypingTicket(ctx context.Context, userID, contextToken string) (string, error) {
	var resp struct {
		result
		TypingTicket string `json:"typing_ticket"`
	}
	body := map[string]any{"ilink_user_id": userID, "base_info": c.baseInfo()}
	if contextToken != "" {
		body["context_token"] = contextToken
	}
	if err := c.post(ctx, "getconfig", "/ilink/bot/getconfig", body, true, lightTimeout, &resp); err != nil {
		return "", err
	}
	if err := resp.err("getconfig"); err != nil {
		return "", err
	}
	return resp.TypingTicket, nil
}

// SendTyping shows (typing true) or clears the typing state for a user.
func (c *Client) SendTyping(ctx context.Context, userID, ticket string, typing bool) error {
	status := 2
	if typing {
		status = 1
	}
	body := map[string]any{"ilink_user_id": userID, "typing_ticket": ticket, "status": status, "base_info": c.baseInfo()}
	return c.post(ctx, "sendtyping", "/ilink/bot/sendtyping", body, true, lightTimeout, nil)
}

// NotifyStart and NotifyStop tell the server the client started or stopped polling.
func (c *Client) NotifyStart(ctx context.Context) error { return c.notify(ctx, "notifystart") }
func (c *Client) NotifyStop(ctx context.Context) error  { return c.notify(ctx, "notifystop") }

func (c *Client) notify(ctx context.Context, op string) error {
	var resp result
	if err := c.post(ctx, op, "/ilink/bot/msg/"+op, map[string]any{"base_info": c.baseInfo()}, true, lightTimeout, &resp); err != nil {
		return err
	}
	return resp.err(op)
}

func newClientID() string {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	return "morph-" + hex.EncodeToString(raw[:])
}

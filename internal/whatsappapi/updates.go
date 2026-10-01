package whatsappapi

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Message is an inbound message. From is the sender as "user:<id>", to send back unchanged.
type Message struct {
	From      string          `json:"from"`
	ID        string          `json:"id"`
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Text      *Text           `json:"text,omitempty"`
	Context   *MessageContext `json:"context,omitempty"`
	Image     *Media          `json:"image,omitempty"`
	Audio     *Media          `json:"audio,omitempty"`
	Video     *Media          `json:"video,omitempty"`
	Document  *Media          `json:"document,omitempty"`
	Sticker   *Media          `json:"sticker,omitempty"`
	Reaction  *Reaction       `json:"reaction,omitempty"`
}

type Text struct {
	Body string `json:"body"`
}

// MessageContext names the message this one quotes; From is "agent:<id>" when it is the agent's.
type MessageContext struct {
	ID   string `json:"id"`
	From string `json:"from"`
}

// Media is an inbound media object; SHA256 is Base64. Voice is set on a voice note.
type Media struct {
	ID       string `json:"id"`
	MimeType string `json:"mime_type,omitempty"`
	SHA256   string `json:"sha256,omitempty"`
	Caption  string `json:"caption,omitempty"`
	Filename string `json:"filename,omitempty"`
	Voice    bool   `json:"voice,omitempty"`
}

// MediaObject is the message's media and its type ("image", "audio", ...), or nil.
func (m Message) MediaObject() (*Media, string) {
	switch m.Type {
	case "image":
		return m.Image, m.Type
	case "audio":
		return m.Audio, m.Type
	case "video":
		return m.Video, m.Type
	case "document":
		return m.Document, m.Type
	case "sticker":
		return m.Sticker, m.Type
	}
	return nil, ""
}

type Reaction struct {
	MessageID string `json:"message_id"`
	Emoji     string `json:"emoji"`
}

// SentAt is the message's timestamp, or zero.
func (m Message) SentAt() time.Time {
	seconds, err := strconv.ParseInt(strings.TrimSpace(m.Timestamp), 10, 64)
	if err != nil || seconds <= 0 {
		return time.Time{}
	}
	return time.Unix(seconds, 0).UTC()
}

// Status is a delivery or read receipt for a message the agent sent.
type Status struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	RecipientID string `json:"recipient_id"`
	Timestamp   string `json:"timestamp"`
}

// Contact is the other party; Name is set only when the user has a profile name.
type Contact struct {
	WaID string
	Name string
}

// Updates is one poll. Empty is a 204: nothing arrived, and the offset stays as it was.
type Updates struct {
	AgentID    string
	Messages   []Message
	Statuses   []Status
	Contacts   []Contact
	NextOffset int64
	Empty      bool
}

// GetUpdates long-polls for messages and receipts from offset, holding the request up to timeout
// (at most 25 seconds). Pass the previous NextOffset back unchanged; offset 0 reads all retained
// history. Polls are spaced to stay within 15 a minute.
func (c *Client) GetUpdates(ctx context.Context, offset int64, limit int, timeout time.Duration) (Updates, error) {
	if err := c.updates.wait(ctx, c.now, c.sleep); err != nil {
		return Updates{}, err
	}
	if timeout <= 0 || timeout > MaxPollTimeout {
		timeout = MaxPollTimeout
	}
	query := url.Values{}
	query.Set("offset", formatOffset(offset))
	if limit > 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	query.Set("timeout", strconv.Itoa(int(timeout/time.Second)))
	pollCtx, cancel := context.WithTimeout(ctx, timeout+15*time.Second)
	defer cancel()
	req, err := c.request(pollCtx, http.MethodGet, "/updates?"+query.Encode(), nil)
	if err != nil {
		return Updates{}, err
	}
	var body struct {
		Entry []struct {
			ID      string `json:"id"`
			Changes []struct {
				Value struct {
					Contacts []struct {
						WaID    string `json:"wa_id"`
						Profile *struct {
							Name string `json:"name"`
						} `json:"profile,omitempty"`
					} `json:"contacts"`
					Messages []Message `json:"messages"`
					Statuses []Status  `json:"statuses"`
				} `json:"value"`
			} `json:"changes"`
		} `json:"entry"`
		NextOffset *int64 `json:"next_offset"`
	}
	status, err := c.do(req, &body)
	if err != nil {
		if apiErr, ok := err.(*APIError); ok && apiErr.HTTPStatus == http.StatusConflict {
			return Updates{}, ErrPollReplaced
		}
		return Updates{}, err
	}
	if status == http.StatusNoContent {
		return Updates{Empty: true, NextOffset: offset}, nil
	}
	out := Updates{NextOffset: offset}
	if body.NextOffset != nil {
		out.NextOffset = *body.NextOffset
	}
	for _, entry := range body.Entry {
		if out.AgentID == "" {
			out.AgentID = strings.TrimSpace(entry.ID)
		}
		for _, change := range entry.Changes {
			for _, contact := range change.Value.Contacts {
				item := Contact{WaID: contact.WaID}
				if contact.Profile != nil {
					item.Name = strings.TrimSpace(contact.Profile.Name)
				}
				out.Contacts = append(out.Contacts, item)
			}
			out.Messages = append(out.Messages, change.Value.Messages...)
			out.Statuses = append(out.Statuses, change.Value.Statuses...)
		}
	}
	return out, nil
}

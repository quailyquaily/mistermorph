package whatsappapi

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"unicode/utf8"
)

// UserID strips the "user:" prefix from a participant, returning the bare id; "" when the value
// is not a user.
func UserID(participant string) string {
	value := strings.TrimSpace(participant)
	if !strings.HasPrefix(value, "user:") {
		return ""
	}
	id := strings.TrimSpace(value[len("user:"):])
	if id == "" || strings.ContainsAny(id, ": \t\r\n") {
		return ""
	}
	return id
}

// Participant is the "user:<id>" form the API takes for a bare id.
func Participant(userID string) string {
	return "user:" + strings.TrimSpace(userID)
}

// SendText sends text to the agent's creator, quoting replyTo (a wamid) when set, and returns the
// new message's wamid. Sends are spaced to stay within 12 a minute; the caller sends to one
// recipient at a time, since the server does not order concurrent sends. A send whose outcome is
// unknown returns ErrSendUnknown and must not be retried blindly.
func (c *Client) SendText(ctx context.Context, userID, text, replyTo string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("whatsapp send: text is required")
	}
	if utf8.RuneCountInString(text) > MaxTextLength {
		return "", fmt.Errorf("whatsapp send: text is longer than %d characters", MaxTextLength)
	}
	return c.sendMessage(ctx, userID, map[string]any{"type": "text", "text": map[string]any{"body": text}}, replyTo)
}

// sendMessage posts one message of any type (fields holds "type" and its object) to userID.
func (c *Client) sendMessage(ctx context.Context, userID string, fields map[string]any, replyTo string) (string, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "", fmt.Errorf("whatsapp send: recipient is required")
	}
	body := map[string]any{"messaging_product": "whatsapp", "to": Participant(userID)}
	for key, value := range fields {
		body[key] = value
	}
	if replyTo = strings.TrimSpace(replyTo); replyTo != "" {
		body["context"] = map[string]string{"message_id": replyTo}
	}
	if err := c.sends.wait(ctx, c.now, c.sleep); err != nil {
		return "", err
	}
	sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	req, err := c.request(sendCtx, http.MethodPost, "/messages", body)
	if err != nil {
		return "", err
	}
	var resp struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	status, err := c.do(req, &resp)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if status >= 500 && !IsRetryable(err) || status == 0 && isUncertain(err) {
			return "", fmt.Errorf("%w: %v", ErrSendUnknown, err)
		}
		return "", err
	}
	if len(resp.Messages) == 0 {
		return "", nil
	}
	return resp.Messages[0].ID, nil
}

// isUncertain is a transport failure after the request may have reached the server.
func isUncertain(err error) bool {
	var netErr net.Error
	return errors.Is(err, context.DeadlineExceeded) || errors.As(err, &netErr) || strings.Contains(err.Error(), "connection reset")
}

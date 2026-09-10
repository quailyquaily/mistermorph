package mixin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/mixinapi"
	"github.com/quailyquaily/mistermorph/internal/textutil"
)

// HandlePlainMessage replies to human senders without processing the message body.
// Errors propagate to Blaze so failed profile reads or replies remain unacknowledged.
func (i *mixinIngress) HandlePlainMessage(ctx context.Context, message mixinapi.MessageView) (bool, error) {
	if !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(message.Category)), "PLAIN_") {
		return false, nil
	}
	conversationID := strings.TrimSpace(message.ConversationID)
	senderID := strings.TrimSpace(message.UserID)
	messageID := strings.TrimSpace(message.MessageID)
	if conversationID == "" || senderID == "" || messageID == "" ||
		strings.EqualFold(senderID, i.bot.UserID) || message.Source == "ACKNOWLEDGE_MESSAGE_RECEIPT" {
		return true, nil
	}
	if i.api == nil {
		return true, fmt.Errorf("mixin api is unavailable")
	}
	// Do not use the best-effort profile cache: a failed lookup must not turn a bot into a human.
	sender, err := i.api.ReadUser(ctx, senderID)
	if err != nil {
		return true, fmt.Errorf("read plain mixin message sender: %w", err)
	}
	if !strings.EqualFold(strings.TrimSpace(sender.UserID), senderID) {
		return true, fmt.Errorf("mixin sender profile does not match sender")
	}
	if strings.TrimSpace(sender.AppID) != "" {
		return true, nil
	}
	appID := strings.TrimSpace(i.bot.AppID)
	if appID == "" {
		appID = strings.TrimSpace(i.bot.UserID)
	}
	title := textutil.TruncateRunes(i.bot.FullName, 36)
	if title == "" {
		title = "Morph"
	}
	card, err := json.Marshal(map[string]string{
		"app_id": appID, "title": title, "icon_url": strings.TrimSpace(i.bot.AvatarURL),
		"description": "Open this bot and send your message again.",
		"action":      "mixin://apps/" + appID,
	})
	if err != nil {
		return true, err
	}
	replyID := uuid.NewSHA1(uuid.NameSpaceOID, []byte("mixin:plain-app-card:"+i.bot.UserID+":"+messageID))
	err = i.api.SendMessages(ctx, []mixinapi.MessageRequest{{
		ConversationID: conversationID, RecipientID: senderID, MessageID: replyID.String(),
		Category: mixinapi.MessageCategoryAppCard, DataBase64: base64.RawURLEncoding.EncodeToString(card),
	}})
	if err != nil {
		return true, fmt.Errorf("send mixin app card: %w", err)
	}
	return true, nil
}

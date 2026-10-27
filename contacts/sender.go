package contacts

import (
	"context"
	"strconv"
	"strings"

	refid "github.com/quailyquaily/mistermorph/internal/entryutil/refid"
)

// InboundSender is who sent an inbound message, as the channel reports it.
type InboundSender struct {
	Channel string
	// UserID is the platform's user ID: a number for Telegram, an open ID for Lark.
	UserID string
	// Username is the Telegram username, without "@".
	Username string
	// TeamID is the Slack workspace.
	TeamID string
}

// SenderContactIDs are the contact IDs the inbound observer stores a sender under, primary first.
// They follow the observer's rules (bus_observe.go), so a lookup finds the contact it recorded.
func SenderContactIDs(sender InboundSender) []string {
	userID := strings.TrimSpace(sender.UserID)
	switch strings.ToLower(strings.TrimSpace(sender.Channel)) {
	case ChannelTelegram:
		numericID, _ := strconv.ParseInt(userID, 10, 64)
		var ids []string
		if id := telegramContactIDFromUser(sender.Username, numericID); id != "" {
			ids = append(ids, id)
		}
		if numericID > 0 && normalizeTelegramUsername(sender.Username) != "" {
			ids = append(ids, "tg:"+strconv.FormatInt(numericID, 10))
		}
		return ids
	case ChannelSlack:
		return nonEmptyIDs(slackContactIDFromUser(sender.TeamID, userID))
	case ChannelLine:
		return nonEmptyIDs(lineContactIDFromUser(userID))
	case ChannelLark:
		return nonEmptyIDs(larkContactIDFromUser(userID))
	case ChannelMixin:
		return prefixedID("mixin:", refid.NormalizeMixinID(userID))
	case ChannelDiscord:
		return prefixedID("discord_user:", refid.NormalizeDiscordID(userID))
	case ChannelWeChat:
		return prefixedID("wechat_user:", refid.NormalizeWeChatID(userID))
	case ChannelWhatsApp:
		return prefixedID("whatsapp_user:", refid.NormalizeWhatsAppID(userID))
	case ChannelBluesky:
		return prefixedID("bluesky_user:", refid.NormalizeBlueskyID(userID))
	case ChannelX:
		return prefixedID("x_user:", refid.NormalizeXUserID(userID))
	}
	return nil
}

// LookupSender finds the stored contact of a sender. A Telegram contact that records a user ID
// matches only a sender with that ID, so a username that changed hands does not reach the old
// contact.
func (s *Service) LookupSender(ctx context.Context, sender InboundSender) (Contact, bool, error) {
	if s == nil || !s.ready() {
		return Contact{}, false, nil
	}
	for _, id := range SenderContactIDs(sender) {
		contact, ok, err := s.GetContact(ctx, id)
		if err != nil {
			return Contact{}, false, err
		}
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(sender.Channel), ChannelTelegram) && contact.TGUserID != 0 {
			numericID, _ := strconv.ParseInt(strings.TrimSpace(sender.UserID), 10, 64)
			if numericID != contact.TGUserID {
				continue
			}
		}
		return contact, true, nil
	}
	return Contact{}, false, nil
}

func nonEmptyIDs(id string) []string {
	if id == "" {
		return nil
	}
	return []string{id}
}

func prefixedID(prefix, id string) []string {
	if id == "" {
		return nil
	}
	return []string{prefix + id}
}

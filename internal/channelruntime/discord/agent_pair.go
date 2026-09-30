package discord

import (
	"context"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/agentpair"
	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
)

// discordPairTargetUserID reads the target of "/pair @Agent": a mention (<@id> or <@!id>), a
// discord_user:<id> reference, or a bare user ID.
func discordPairTargetUserID(args string) (string, error) {
	value := strings.TrimSpace(args)
	if strings.HasPrefix(value, "<@") && strings.HasSuffix(value, ">") {
		value = strings.TrimPrefix(strings.TrimSuffix(strings.TrimPrefix(value, "<@"), ">"), "!")
	} else if strings.HasPrefix(strings.ToLower(value), "discord_user:") {
		value = value[len("discord_user:"):]
	}
	id, err := discordbus.NormalizeSnowflake("user_id", value)
	if err != nil {
		return "", fmt.Errorf("usage: /pair @Agent")
	}
	return id, nil
}

func discordPairTarget(ctx context.Context, service *contacts.Service, args string) (agentpair.Peer, error) {
	userID, err := discordPairTargetUserID(args)
	if err != nil {
		return agentpair.Peer{}, err
	}
	if service == nil {
		return agentpair.Peer{}, fmt.Errorf("contacts service is unavailable")
	}
	items, err := service.ListContacts(ctx, contacts.StatusActive)
	if err != nil {
		return agentpair.Peer{}, err
	}
	for _, contact := range items {
		if contact.Kind == contacts.KindAgent && strings.EqualFold(strings.TrimSpace(contact.Channel), contacts.ChannelDiscord) && strings.TrimSpace(contact.DiscordUserID) == userID {
			return agentpair.Peer{ID: "discord_user:" + userID, Contact: contact}, nil
		}
	}
	return agentpair.Peer{}, fmt.Errorf("pair target must be an existing Discord Agent contact")
}

func discordInboundAgentPeer(inbound discordbus.InboundMessage) agentpair.Peer {
	userID := strings.TrimSpace(inbound.UserID)
	kind := contacts.KindHuman
	if inbound.FromIsAgent {
		kind = contacts.KindAgent
	}
	contact := contacts.Contact{
		ContactID: "discord_user:" + userID, Kind: kind, Channel: contacts.ChannelDiscord,
		ContactNickname: firstNonEmpty(inbound.DisplayName, inbound.Username), DiscordUserID: userID,
	}
	if inbound.ChatType == discordbus.ChatTypePrivate {
		contact.DiscordDMChannelID = strings.TrimSpace(inbound.ChannelID)
	}
	return agentpair.Peer{ID: "discord_user:" + userID, Contact: contact}
}

// discordPairSendUserID is the Discord user a pairing message goes to.
func discordPairSendUserID(peer agentpair.Peer) (string, error) {
	if userID := strings.TrimSpace(peer.Contact.DiscordUserID); userID != "" {
		return userID, nil
	}
	id := strings.TrimSpace(peer.ID)
	if strings.HasPrefix(strings.ToLower(id), "discord_user:") {
		return discordbus.NormalizeSnowflake("user_id", id[len("discord_user:"):])
	}
	return "", fmt.Errorf("Discord pair target requires a user ID")
}

func discordPairReplyText(status agentpair.Status, err error) string {
	if err != nil {
		return "Pairing failed: " + strings.TrimSpace(err.Error())
	}
	switch status {
	case agentpair.StatusCompleted:
		return "Agent pairing completed."
	case agentpair.StatusAlreadyPaired:
		return "This Agent is already paired."
	default:
		return "Pairing request sent. It expires in 5 minutes."
	}
}

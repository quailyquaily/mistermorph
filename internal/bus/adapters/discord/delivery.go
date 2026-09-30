package discord

import (
	"context"
	"fmt"
	"strings"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
)

type SendTextOptions struct {
	// ReplyToMessageID makes the first message a reply to it.
	ReplyToMessageID string
	CorrelationID    string
}

type SendTextFunc func(ctx context.Context, channelID, text string, opts SendTextOptions) error

type DeliveryAdapterOptions struct {
	SendText SendTextFunc
}

type DeliveryAdapter struct {
	sendText SendTextFunc
}

func NewDeliveryAdapter(opts DeliveryAdapterOptions) (*DeliveryAdapter, error) {
	if opts.SendText == nil {
		return nil, fmt.Errorf("send text func is required")
	}
	return &DeliveryAdapter{sendText: opts.SendText}, nil
}

// Deliver sends an outbound bus message to its Discord channel.
func (a *DeliveryAdapter) Deliver(ctx context.Context, msg busruntime.BusMessage) (bool, bool, error) {
	if a == nil || a.sendText == nil {
		return false, false, fmt.Errorf("discord delivery adapter is not initialized")
	}
	if ctx == nil {
		return false, false, fmt.Errorf("context is required")
	}
	if msg.Direction != busruntime.DirectionOutbound {
		return false, false, fmt.Errorf("direction must be outbound")
	}
	if msg.Channel != busruntime.ChannelDiscord {
		return false, false, fmt.Errorf("channel must be discord")
	}
	channelID, err := busruntime.ParseDiscordConversationKey(msg.ConversationKey)
	if err != nil {
		return false, false, err
	}
	envelope, err := msg.Envelope()
	if err != nil {
		return false, false, err
	}
	text := strings.TrimSpace(envelope.Text)
	if text == "" {
		return false, false, fmt.Errorf("discord outbound text is empty")
	}
	replyTo := strings.TrimSpace(msg.Extensions.ReplyTo)
	if replyTo == "" {
		replyTo = strings.TrimSpace(envelope.ReplyTo)
	}
	if err := a.sendText(ctx, channelID, text, SendTextOptions{ReplyToMessageID: replyTo, CorrelationID: strings.TrimSpace(msg.CorrelationID)}); err != nil {
		return false, false, err
	}
	return true, false, nil
}

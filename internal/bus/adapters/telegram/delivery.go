package telegram

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
)

type SendTextFunc func(ctx context.Context, target any, text string) error

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

func (a *DeliveryAdapter) Deliver(ctx context.Context, msg busruntime.BusMessage) (bool, bool, error) {
	if a == nil || a.sendText == nil {
		return false, false, fmt.Errorf("telegram delivery adapter is not initialized")
	}
	if ctx == nil {
		return false, false, fmt.Errorf("context is required")
	}
	if msg.Direction != busruntime.DirectionOutbound {
		return false, false, fmt.Errorf("direction must be outbound")
	}
	if msg.Channel != busruntime.ChannelTelegram {
		return false, false, fmt.Errorf("channel must be telegram")
	}
	target, err := targetFromMessage(msg)
	if err != nil {
		return false, false, err
	}
	env, err := msg.Envelope()
	if err != nil {
		return false, false, err
	}
	text := strings.TrimSpace(env.Text)
	if err := a.sendText(ctx, target, text); err != nil {
		return false, false, err
	}
	return true, false, nil
}

func chatIDFromConversationKey(conversationKey string) (int64, error) {
	const prefix = "tg:"
	if !strings.HasPrefix(conversationKey, prefix) {
		return 0, fmt.Errorf("telegram conversation key is invalid")
	}
	chatIDRaw := strings.TrimSpace(strings.TrimPrefix(conversationKey, prefix))
	if chatIDRaw == "" {
		return 0, fmt.Errorf("telegram chat id is required")
	}
	chatID, err := strconv.ParseInt(chatIDRaw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("telegram chat id is invalid: %w", err)
	}
	return chatID, nil
}

func targetFromMessage(msg busruntime.BusMessage) (any, error) {
	if chatID, err := chatIDFromConversationKey(msg.ConversationKey); err == nil {
		return chatID, nil
	}
	return nil, fmt.Errorf("telegram conversation key is invalid")
}

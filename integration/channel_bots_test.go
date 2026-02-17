package integration

import (
	"context"
	"errors"
	"testing"

	slackruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/slack"
	telegramruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/telegram"
)

func TestNewTelegramBotRequiresToken(t *testing.T) {
	rt := New(DefaultConfig())

	if _, err := rt.NewTelegramBot(TelegramOptions{}); err == nil {
		t.Fatalf("expected error when telegram bot token is missing")
	}
}

func TestNewSlackBotRequiresTokens(t *testing.T) {
	rt := New(DefaultConfig())

	if _, err := rt.NewSlackBot(SlackOptions{}); err == nil {
		t.Fatalf("expected error when slack tokens are missing")
	}
	if _, err := rt.NewSlackBot(SlackOptions{BotToken: "xoxb-1"}); err == nil {
		t.Fatalf("expected error when slack app token is missing")
	}
}

func TestRunnerCloseAndReentrantGuard(t *testing.T) {
	rt := New(DefaultConfig())
	r, err := rt.NewSlackBot(SlackOptions{
		BotToken: "xoxb-1",
		AppToken: "xapp-1",
	})
	if err != nil {
		t.Fatalf("NewSlackBot() error = %v", err)
	}

	runner := r.(*slackBotRunner)
	ctx, cancel := context.WithCancel(context.Background())
	runCtx, runCancel, err := runner.state.begin(ctx, "slack")
	if err != nil {
		t.Fatalf("beginRun() error = %v", err)
	}
	if runCtx == nil || runCancel == nil {
		t.Fatalf("beginRun() returned nil context/cancel")
	}
	if _, _, err := runner.state.begin(context.Background(), "slack"); err == nil {
		t.Fatalf("expected reentrant beginRun() to fail")
	}
	cancel()
	_ = runner.Close()
	runner.state.end(runCancel)
}

func TestTelegramRuntimeHooksBridge(t *testing.T) {
	var inbound TelegramInboundEvent
	var outbound TelegramOutboundEvent
	var errEvent TelegramErrorEvent

	r := &telegramBotRunner{
		opts: TelegramOptions{
			Hooks: TelegramHooks{
				OnInbound: func(event TelegramInboundEvent) { inbound = event },
				OnOutbound: func(event TelegramOutboundEvent) {
					outbound = event
				},
				OnError: func(event TelegramErrorEvent) { errEvent = event },
			},
		},
	}
	hooks := r.runtimeHooks()
	expectedErr := errors.New("boom")

	hooks.OnInbound(context.Background(), telegramruntime.InboundEvent{
		ChatID:       11,
		MessageID:    22,
		ChatType:     "private",
		FromUserID:   33,
		Text:         "hello",
		MentionUsers: []string{"u1"},
	})
	hooks.OnOutbound(context.Background(), telegramruntime.OutboundEvent{
		ChatID:           11,
		ReplyToMessageID: 22,
		Text:             "ok",
		CorrelationID:    "c1",
		Kind:             "message",
	})
	hooks.OnError(context.Background(), telegramruntime.ErrorEvent{
		Stage:     "test_stage",
		ChatID:    11,
		MessageID: 22,
		Err:       expectedErr,
	})

	if inbound.ChatID != 11 || inbound.MessageID != 22 || inbound.Text != "hello" || len(inbound.MentionUsers) != 1 {
		t.Fatalf("unexpected inbound event: %#v", inbound)
	}
	if outbound.ChatID != 11 || outbound.ReplyToMessageID != 22 || outbound.CorrelationID != "c1" {
		t.Fatalf("unexpected outbound event: %#v", outbound)
	}
	if errEvent.Stage != "test_stage" || errEvent.Err != expectedErr {
		t.Fatalf("unexpected error event: %#v", errEvent)
	}
}

func TestSlackRuntimeHooksBridge(t *testing.T) {
	var inbound SlackInboundEvent
	var outbound SlackOutboundEvent
	var errEvent SlackErrorEvent

	r := &slackBotRunner{
		opts: SlackOptions{
			Hooks: SlackHooks{
				OnInbound: func(event SlackInboundEvent) { inbound = event },
				OnOutbound: func(event SlackOutboundEvent) {
					outbound = event
				},
				OnError: func(event SlackErrorEvent) { errEvent = event },
			},
		},
	}
	hooks := r.runtimeHooks()
	expectedErr := errors.New("boom")

	hooks.OnInbound(context.Background(), slackruntime.InboundEvent{
		ConversationKey: "slack:t:c",
		TeamID:          "T",
		ChannelID:       "C",
		MessageTS:       "1.0",
		UserID:          "U",
		Text:            "hello",
	})
	hooks.OnOutbound(context.Background(), slackruntime.OutboundEvent{
		ConversationKey: "slack:t:c",
		TeamID:          "T",
		ChannelID:       "C",
		ThreadTS:        "1.0",
		Text:            "ok",
		CorrelationID:   "c1",
		Kind:            "message",
	})
	hooks.OnError(context.Background(), slackruntime.ErrorEvent{
		Stage:           "test_stage",
		ConversationKey: "slack:t:c",
		TeamID:          "T",
		ChannelID:       "C",
		MessageTS:       "1.0",
		Err:             expectedErr,
	})

	if inbound.ConversationKey != "slack:t:c" || inbound.TeamID != "T" || inbound.Text != "hello" {
		t.Fatalf("unexpected inbound event: %#v", inbound)
	}
	if outbound.ConversationKey != "slack:t:c" || outbound.CorrelationID != "c1" || outbound.Kind != "message" {
		t.Fatalf("unexpected outbound event: %#v", outbound)
	}
	if errEvent.Stage != "test_stage" || errEvent.Err != expectedErr {
		t.Fatalf("unexpected error event: %#v", errEvent)
	}
}

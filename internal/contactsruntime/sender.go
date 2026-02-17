package contactsruntime

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	maepbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/maep"
	slackbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/slack"
	telegrambus "github.com/quailyquaily/mistermorph/internal/bus/adapters/telegram"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/slackclient"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/maep"
)

const defaultTelegramBaseURL = "https://api.telegram.org"
const defaultSlackBaseURL = "https://slack.com/api"

type SenderOptions struct {
	MAEPDir          string
	TelegramBotToken string
	TelegramBaseURL  string
	SlackBotToken    string
	SlackBaseURL     string
	BusMaxInFlight   int
	Logger           *slog.Logger
}

type RoutingSender struct {
	maepNode         *maep.Node
	bus              *busruntime.Inproc
	telegramDelivery *telegrambus.DeliveryAdapter
	slackDelivery    *slackbus.DeliveryAdapter
	maepDelivery     *maepbus.DeliveryAdapter
	telegramClient   *http.Client
	slackPoster      *slackclient.Client
	telegramBaseURL  string
	telegramBotToken string
	maepDir          string
	logger           *slog.Logger
	maepMu           sync.Mutex
	pendingMu        sync.Mutex
	pending          map[string]chan deliveryResult
	closeOnce        sync.Once
}

type deliveryResult struct {
	accepted bool
	deduped  bool
	err      error
}

func NewRoutingSender(ctx context.Context, opts SenderOptions) (*RoutingSender, error) {
	if ctx == nil {
		return nil, fmt.Errorf("context is required")
	}
	dir := strings.TrimSpace(opts.MAEPDir)
	if dir == "" {
		dir = statepaths.MAEPDir()
	} else {
		dir = pathutil.ExpandHomePath(dir)
	}

	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelWarn}))
	}

	baseURL := strings.TrimSpace(opts.TelegramBaseURL)
	if baseURL == "" {
		baseURL = defaultTelegramBaseURL
	}
	slackBaseURL := strings.TrimSpace(opts.SlackBaseURL)
	if slackBaseURL == "" {
		slackBaseURL = defaultSlackBaseURL
	}

	maxInFlight := opts.BusMaxInFlight
	if maxInFlight <= 0 {
		maxInFlight = 64
	}
	inprocBus, err := busruntime.StartInproc(busruntime.BootstrapOptions{
		MaxInFlight: maxInFlight,
		Logger:      logger,
		Component:   "contactsruntime_sender",
	})
	if err != nil {
		return nil, err
	}

	sender := &RoutingSender{
		bus:              inprocBus,
		telegramClient:   &http.Client{Timeout: 30 * time.Second},
		telegramBaseURL:  baseURL,
		telegramBotToken: strings.TrimSpace(opts.TelegramBotToken),
		slackPoster:      slackclient.New(&http.Client{Timeout: 30 * time.Second}, slackBaseURL, strings.TrimSpace(opts.SlackBotToken)),
		maepDir:          dir,
		logger:           logger,
		pending:          make(map[string]chan deliveryResult),
	}
	sender.telegramDelivery, err = telegrambus.NewDeliveryAdapter(telegrambus.DeliveryAdapterOptions{
		SendText: sender.sendTelegramTarget,
	})
	if err != nil {
		_ = sender.Close()
		return nil, err
	}
	sender.slackDelivery, err = slackbus.NewDeliveryAdapter(slackbus.DeliveryAdapterOptions{
		SendText: sender.sendSlackTarget,
	})
	if err != nil {
		_ = sender.Close()
		return nil, err
	}

	busHandler := func(deliverCtx context.Context, msg busruntime.BusMessage) error {
		switch msg.Direction {
		case busruntime.DirectionOutbound:
		default:
			deliverErr := fmt.Errorf("unsupported direction: %s", msg.Direction)
			if err := sender.completePending(msg.ID, deliveryResult{err: deliverErr}); err != nil {
				return err
			}
			return deliverErr
		}
		var (
			accepted   bool
			deduped    bool
			deliverErr error
		)
		switch msg.Channel {
		case busruntime.ChannelTelegram:
			accepted, deduped, deliverErr = sender.telegramDelivery.Deliver(deliverCtx, msg)
		case busruntime.ChannelSlack:
			accepted, deduped, deliverErr = sender.slackDelivery.Deliver(deliverCtx, msg)
		case busruntime.ChannelMAEP:
			if err := sender.ensureMAEPDelivery(deliverCtx); err != nil {
				deliverErr = err
				break
			}
			accepted, deduped, deliverErr = sender.maepDelivery.Deliver(deliverCtx, msg)
		default:
			deliverErr = fmt.Errorf("unsupported outbound channel: %s", msg.Channel)
		}
		if err := sender.completePending(msg.ID, deliveryResult{
			accepted: accepted,
			deduped:  deduped,
			err:      deliverErr,
		}); err != nil {
			return err
		}
		return deliverErr
	}
	for _, topic := range busruntime.AllTopics() {
		if err := inprocBus.Subscribe(topic, busHandler); err != nil {
			_ = sender.Close()
			return nil, err
		}
	}

	return sender, nil
}

func (s *RoutingSender) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		if s.bus != nil {
			_ = s.bus.Close()
		}
		if s.maepNode != nil {
			_ = s.maepNode.Close()
		}
		s.pendingMu.Lock()
		for id, ch := range s.pending {
			delete(s.pending, id)
			select {
			case ch <- deliveryResult{err: fmt.Errorf("sender is closed")}:
			default:
			}
		}
		s.pendingMu.Unlock()
	})
	return nil
}

func (s *RoutingSender) ensureMAEPDelivery(ctx context.Context) error {
	if s == nil {
		return fmt.Errorf("sender is required")
	}
	s.maepMu.Lock()
	defer s.maepMu.Unlock()
	if s.maepDelivery != nil && s.maepNode != nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	svc := maep.NewService(maep.NewFileStore(s.maepDir))
	node, err := maep.NewNode(ctx, svc, maep.NodeOptions{DialOnly: true, Logger: s.logger})
	if err != nil {
		return err
	}
	delivery, err := maepbus.NewDeliveryAdapter(maepbus.DeliveryAdapterOptions{
		Node: node,
	})
	if err != nil {
		_ = node.Close()
		return err
	}
	s.maepNode = node
	s.maepDelivery = delivery
	return nil
}

func (s *RoutingSender) Send(ctx context.Context, contact contacts.Contact, decision contacts.ShareDecision) (bool, bool, error) {
	if s == nil {
		return false, false, fmt.Errorf("nil routing sender")
	}
	if ctx == nil {
		return false, false, fmt.Errorf("context is required")
	}
	channel, err := contacts.ResolveDecisionChannel(contact, decision)
	if err != nil {
		return false, false, err
	}
	switch channel {
	case contacts.ChannelSlack:
		if slackTeamID, slackChannelID, hasSlackHint, slackHintErr := parseSlackChatIDHint(decision.ChatID); hasSlackHint || slackHintErr != nil {
			if slackHintErr != nil {
				return false, false, slackHintErr
			}
			return s.publishSlack(ctx, slackbus.DeliveryTarget{
				TeamID:    slackTeamID,
				ChannelID: slackChannelID,
			}, decision)
		}
		target, _, resolveErr := ResolveSlackTarget(contact)
		if resolveErr != nil {
			return false, false, resolveErr
		}
		return s.publishSlack(ctx, target, decision)
	case contacts.ChannelTelegram:
		target, _, resolveErr := ResolveTelegramTargetWithChatID(contact, decision.ChatID)
		if resolveErr != nil {
			return false, false, resolveErr
		}
		return s.publishTelegram(ctx, target, decision)
	case contacts.ChannelMAEP:
		return s.publishMAEP(ctx, contact, decision)
	default:
		return false, false, fmt.Errorf("unsupported delivery channel: %s", channel)
	}
}

func (s *RoutingSender) publishMAEP(ctx context.Context, contact contacts.Contact, decision contacts.ShareDecision) (bool, bool, error) {
	if s == nil || s.bus == nil {
		return false, false, fmt.Errorf("sender bus is not configured")
	}
	peerID := strings.TrimSpace(decision.PeerID)
	if peerID == "" {
		peerID = resolveContactMAEPPeerID(contact)
	}
	if peerID == "" {
		return false, false, fmt.Errorf("maep peer_id is required")
	}
	idempotencyKey := strings.TrimSpace(decision.IdempotencyKey)
	if idempotencyKey == "" {
		return false, false, fmt.Errorf("idempotency_key is required")
	}
	topic := contacts.ShareTopic
	now := time.Now().UTC()
	payloadRaw, err := buildEnvelopePayload(decision, decision.ContentType, decision.PayloadBase64, now)
	if err != nil {
		return false, false, err
	}
	payloadBase64 := base64.RawURLEncoding.EncodeToString(payloadRaw)
	conversationKey, err := busruntime.BuildMAEPPeerConversationKey(peerID)
	if err != nil {
		return false, false, err
	}
	msg := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionOutbound,
		Channel:         busruntime.ChannelMAEP,
		Topic:           topic,
		ConversationKey: conversationKey,
		ParticipantKey:  peerID,
		IdempotencyKey:  idempotencyKey,
		CorrelationID:   "contactsruntime:maep:" + idempotencyKey,
		PayloadBase64:   payloadBase64,
		CreatedAt:       now,
	}
	return s.publishAndAwait(ctx, msg)
}

func (s *RoutingSender) publishTelegram(ctx context.Context, target any, decision contacts.ShareDecision) (bool, bool, error) {
	if s == nil || s.bus == nil {
		return false, false, fmt.Errorf("sender bus is not configured")
	}
	idempotencyKey := strings.TrimSpace(decision.IdempotencyKey)
	if idempotencyKey == "" {
		return false, false, fmt.Errorf("idempotency_key is required")
	}
	topic := contacts.ShareTopic
	now := time.Now().UTC()
	payloadRaw, err := buildEnvelopePayload(decision, decision.ContentType, decision.PayloadBase64, now)
	if err != nil {
		return false, false, err
	}
	payloadBase64 := base64.RawURLEncoding.EncodeToString(payloadRaw)
	conversationKey, participantKey, err := telegramConversationFromTarget(target)
	if err != nil {
		return false, false, err
	}
	msg := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionOutbound,
		Channel:         busruntime.ChannelTelegram,
		Topic:           topic,
		ConversationKey: conversationKey,
		ParticipantKey:  participantKey,
		IdempotencyKey:  idempotencyKey,
		CorrelationID:   "contactsruntime:telegram:" + idempotencyKey,
		PayloadBase64:   payloadBase64,
		CreatedAt:       now,
	}
	return s.publishAndAwait(ctx, msg)
}

func (s *RoutingSender) publishSlack(ctx context.Context, target any, decision contacts.ShareDecision) (bool, bool, error) {
	if s == nil || s.bus == nil {
		return false, false, fmt.Errorf("sender bus is not configured")
	}
	idempotencyKey := strings.TrimSpace(decision.IdempotencyKey)
	if idempotencyKey == "" {
		return false, false, fmt.Errorf("idempotency_key is required")
	}
	topic := contacts.ShareTopic
	now := time.Now().UTC()
	payloadRaw, err := buildEnvelopePayload(decision, decision.ContentType, decision.PayloadBase64, now)
	if err != nil {
		return false, false, err
	}
	payloadBase64 := base64.RawURLEncoding.EncodeToString(payloadRaw)
	conversationKey, participantKey, resolvedTarget, err := slackConversationFromTarget(target)
	if err != nil {
		return false, false, err
	}
	msg := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionOutbound,
		Channel:         busruntime.ChannelSlack,
		Topic:           topic,
		ConversationKey: conversationKey,
		ParticipantKey:  participantKey,
		IdempotencyKey:  idempotencyKey,
		CorrelationID:   "contactsruntime:slack:" + idempotencyKey,
		PayloadBase64:   payloadBase64,
		CreatedAt:       now,
		Extensions: busruntime.MessageExtensions{
			TeamID:    strings.TrimSpace(resolvedTarget.TeamID),
			ChannelID: strings.TrimSpace(resolvedTarget.ChannelID),
		},
	}
	return s.publishAndAwait(ctx, msg)
}

func (s *RoutingSender) publishAndAwait(ctx context.Context, msg busruntime.BusMessage) (bool, bool, error) {
	if s == nil || s.bus == nil {
		return false, false, fmt.Errorf("sender bus is not configured")
	}
	if ctx == nil {
		return false, false, fmt.Errorf("context is required")
	}
	msgID := strings.TrimSpace(msg.ID)
	if msgID == "" {
		return false, false, fmt.Errorf("message id is required")
	}

	resultCh := make(chan deliveryResult, 1)
	if err := s.registerPending(msgID, resultCh); err != nil {
		return false, false, err
	}

	if err := s.bus.PublishValidated(ctx, msg); err != nil {
		s.dropPending(msgID)
		return false, false, err
	}

	select {
	case result := <-resultCh:
		return result.accepted, result.deduped, result.err
	case <-ctx.Done():
		return false, false, ctx.Err()
	}
}

func (s *RoutingSender) registerPending(msgID string, resultCh chan deliveryResult) error {
	if s == nil {
		return fmt.Errorf("sender is required")
	}
	if strings.TrimSpace(msgID) == "" {
		return fmt.Errorf("message id is required")
	}
	if resultCh == nil {
		return fmt.Errorf("result channel is required")
	}
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if _, exists := s.pending[msgID]; exists {
		return fmt.Errorf("pending delivery already exists: %s", msgID)
	}
	s.pending[msgID] = resultCh
	return nil
}

func (s *RoutingSender) completePending(msgID string, result deliveryResult) error {
	if s == nil {
		return fmt.Errorf("sender is required")
	}
	msgID = strings.TrimSpace(msgID)
	if msgID == "" {
		return fmt.Errorf("message id is required")
	}
	s.pendingMu.Lock()
	resultCh, ok := s.pending[msgID]
	if ok {
		delete(s.pending, msgID)
	}
	s.pendingMu.Unlock()
	if !ok {
		return fmt.Errorf("pending delivery not found: %s", msgID)
	}
	resultCh <- result
	return nil
}

func (s *RoutingSender) dropPending(msgID string) {
	if s == nil {
		return
	}
	s.pendingMu.Lock()
	delete(s.pending, strings.TrimSpace(msgID))
	s.pendingMu.Unlock()
}

func buildMAEPDataPushRequest(decision contacts.ShareDecision, now time.Time) (maep.DataPushRequest, error) {
	now = now.UTC()
	req := maep.DataPushRequest{
		Topic:          contacts.ShareTopic,
		ContentType:    strings.TrimSpace(decision.ContentType),
		PayloadBase64:  strings.TrimSpace(decision.PayloadBase64),
		IdempotencyKey: strings.TrimSpace(decision.IdempotencyKey),
	}
	envelopePayload, err := buildEnvelopePayload(decision, req.ContentType, req.PayloadBase64, now)
	if err != nil {
		return maep.DataPushRequest{}, err
	}
	req.ContentType = "application/json"
	req.PayloadBase64 = base64.RawURLEncoding.EncodeToString(envelopePayload)
	return req, nil
}

func buildEnvelopePayload(decision contacts.ShareDecision, contentType string, payloadBase64 string, now time.Time) ([]byte, error) {
	text, extras, err := decodeEnvelopeTextAndExtras(contentType, payloadBase64)
	if err != nil {
		return nil, err
	}
	messageID := strings.TrimSpace(decision.ItemID)
	if messageID == "" {
		messageID = "msg_" + uuid.NewString()
	}
	payload := map[string]any{
		"message_id": messageID,
		"text":       text,
		"sent_at":    now.Format(time.RFC3339),
	}
	sessionID := strings.TrimSpace(extras["session_id"])
	if maep.IsDialogueTopic(contacts.ShareTopic) && sessionID == "" {
		return nil, fmt.Errorf("session_id is required for dialogue topics")
	}
	if sessionID != "" {
		if err := validateSessionID(sessionID); err != nil {
			return nil, err
		}
		payload["session_id"] = sessionID
	}
	if replyTo := strings.TrimSpace(extras["reply_to"]); replyTo != "" {
		payload["reply_to"] = replyTo
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal envelope payload: %w", err)
	}
	return raw, nil
}

func validateSessionID(sessionID string) error {
	id, err := uuid.Parse(strings.TrimSpace(sessionID))
	if err != nil {
		return fmt.Errorf("session_id must be uuid_v7")
	}
	if id.Version() != uuid.Version(7) {
		return fmt.Errorf("session_id must be uuid_v7")
	}
	return nil
}

func decodeEnvelopeTextAndExtras(contentType string, payloadBase64 string) (string, map[string]string, error) {
	payloadBytes, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(payloadBase64))
	if err != nil {
		return "", nil, fmt.Errorf("decode payload_base64: %w", err)
	}
	extras := map[string]string{}
	lowerType := strings.ToLower(strings.TrimSpace(contentType))
	if strings.HasPrefix(lowerType, "application/json") {
		var obj map[string]any
		if err := json.Unmarshal(payloadBytes, &obj); err == nil {
			for _, key := range []string{"text", "message", "content", "prompt"} {
				if v, ok := obj[key].(string); ok && strings.TrimSpace(v) != "" {
					if session, ok := obj["session_id"].(string); ok {
						extras["session_id"] = strings.TrimSpace(session)
					}
					if replyTo, ok := obj["reply_to"].(string); ok {
						extras["reply_to"] = strings.TrimSpace(replyTo)
					}
					return strings.TrimSpace(v), extras, nil
				}
			}
			normalized, err := json.Marshal(obj)
			if err == nil {
				return strings.TrimSpace(string(normalized)), extras, nil
			}
		}
	}
	text := strings.TrimSpace(string(payloadBytes))
	if text == "" {
		text = "(empty)"
	}
	return text, extras, nil
}

func telegramConversationFromTarget(target any) (string, string, error) {
	resolvedTarget, err := normalizeTelegramSendTarget(target)
	if err != nil {
		return "", "", err
	}
	chatID, ok := resolvedTarget.(int64)
	if !ok {
		return "", "", fmt.Errorf("unsupported telegram target type: %T", resolvedTarget)
	}
	conversationKey, err := busruntime.BuildTelegramChatConversationKey(strconv.FormatInt(chatID, 10))
	if err != nil {
		return "", "", err
	}
	return conversationKey, strconv.FormatInt(chatID, 10), nil
}

func slackConversationFromTarget(target any) (string, string, slackbus.DeliveryTarget, error) {
	resolvedTarget, err := normalizeSlackSendTarget(target)
	if err != nil {
		return "", "", slackbus.DeliveryTarget{}, err
	}
	conversationID := strings.TrimSpace(resolvedTarget.TeamID) + ":" + strings.TrimSpace(resolvedTarget.ChannelID)
	conversationKey, err := busruntime.BuildSlackChannelConversationKey(conversationID)
	if err != nil {
		return "", "", slackbus.DeliveryTarget{}, err
	}
	participantKey := strings.TrimSpace(resolvedTarget.TeamID) + ":" + strings.TrimSpace(resolvedTarget.ChannelID)
	return conversationKey, participantKey, resolvedTarget, nil
}

func normalizeTelegramSendTarget(target any) (any, error) {
	switch value := target.(type) {
	case int64:
		if value == 0 {
			return nil, fmt.Errorf("telegram chat id is required")
		}
		return value, nil
	case int:
		if value == 0 {
			return nil, fmt.Errorf("telegram chat id is required")
		}
		return int64(value), nil
	case string:
		targetText := strings.TrimSpace(value)
		if targetText == "" {
			return nil, fmt.Errorf("telegram target is required")
		}
		chatID, err := strconv.ParseInt(targetText, 10, 64)
		if err != nil || chatID == 0 {
			return nil, fmt.Errorf("telegram target is invalid: %s", targetText)
		}
		return chatID, nil
	default:
		return nil, fmt.Errorf("unsupported telegram target type: %T", target)
	}
}

func normalizeSlackSendTarget(target any) (slackbus.DeliveryTarget, error) {
	switch value := target.(type) {
	case slackbus.DeliveryTarget:
		teamID := strings.TrimSpace(value.TeamID)
		channelID := strings.TrimSpace(value.ChannelID)
		if teamID == "" || channelID == "" {
			return slackbus.DeliveryTarget{}, fmt.Errorf("slack team_id and channel_id are required")
		}
		return slackbus.DeliveryTarget{
			TeamID:    teamID,
			ChannelID: channelID,
		}, nil
	default:
		return slackbus.DeliveryTarget{}, fmt.Errorf("unsupported slack target type: %T", target)
	}
}

func (s *RoutingSender) sendTelegramTarget(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
	if s == nil {
		return fmt.Errorf("sender is required")
	}
	if ctx == nil {
		return fmt.Errorf("context is required")
	}
	token := strings.TrimSpace(s.telegramBotToken)
	if token == "" {
		return fmt.Errorf("telegram sender is not configured")
	}
	if s.telegramClient == nil {
		return fmt.Errorf("telegram client is not configured")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return fmt.Errorf("telegram text is required")
	}

	resolvedTarget, err := normalizeTelegramSendTarget(target)
	if err != nil {
		return err
	}

	body := map[string]any{
		"chat_id":                  resolvedTarget,
		"text":                     text,
		"disable_web_page_preview": true,
	}
	replyToRaw := strings.TrimSpace(opts.ReplyTo)
	if replyToRaw != "" {
		replyToMessageID, parseErr := strconv.ParseInt(replyToRaw, 10, 64)
		if parseErr != nil || replyToMessageID <= 0 {
			return fmt.Errorf("telegram reply_to is invalid")
		}
		body["reply_to_message_id"] = replyToMessageID
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal telegram payload: %w", err)
	}

	url := strings.TrimRight(strings.TrimSpace(s.telegramBaseURL), "/") + "/bot" + token + "/sendMessage"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.telegramClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respRaw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(respRaw)))
	}
	var out struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(respRaw, &out); err != nil {
		return fmt.Errorf("decode telegram response: %w", err)
	}
	if !out.OK {
		desc := strings.TrimSpace(out.Description)
		if desc == "" {
			desc = "ok=false"
		}
		return fmt.Errorf("telegram sendMessage failed: %s", desc)
	}
	return nil
}

func (s *RoutingSender) sendSlackTarget(ctx context.Context, target any, text string, opts slackbus.SendTextOptions) error {
	if s == nil {
		return fmt.Errorf("sender is required")
	}
	if ctx == nil {
		return fmt.Errorf("context is required")
	}
	if s.slackPoster == nil {
		return fmt.Errorf("slack sender is not configured")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return fmt.Errorf("slack text is required")
	}

	resolvedTarget, err := normalizeSlackSendTarget(target)
	if err != nil {
		return err
	}
	return s.slackPoster.PostMessage(ctx, resolvedTarget.ChannelID, text, strings.TrimSpace(opts.ThreadTS))
}

func ResolveTelegramTarget(contact contacts.Contact) (any, string, error) {
	if chatID, chatType, ok := preferredChat(contact); ok {
		return chatID, chatType, nil
	}
	value := strings.TrimSpace(contact.ContactID)
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "tg:@") {
		return nil, "", fmt.Errorf("telegram username target is not sendable: %s", value)
	}
	if strings.HasPrefix(lower, "tg:") {
		idText := strings.TrimSpace(value[len("tg:"):])
		chatID, err := strconv.ParseInt(idText, 10, 64)
		if err != nil {
			return nil, "", fmt.Errorf("invalid telegram id in %q", value)
		}
		return chatID, chatTypeFromChatID(chatID), nil
	}
	return nil, "", fmt.Errorf("telegram target not found in tg_private_chat_id/tg_group_chat_ids/contact_id")
}

func ResolveTelegramTargetWithChatID(contact contacts.Contact, chatIDHint string) (any, string, error) {
	hintID, hasHint, err := parseTelegramChatIDHint(chatIDHint)
	if err != nil {
		return nil, "", err
	}
	if !hasHint {
		return ResolveTelegramTarget(contact)
	}
	if chatID, chatType, ok := contactTelegramChatMatch(contact, hintID); ok {
		return chatID, chatType, nil
	}
	if contact.TGPrivateChatID != 0 {
		return contact.TGPrivateChatID, "private", nil
	}
	return nil, "", fmt.Errorf("telegram chat_id %d not found in tg_private_chat_id/tg_group_chat_ids and no tg_private_chat_id fallback", hintID)
}

func ResolveSlackTarget(contact contacts.Contact) (slackbus.DeliveryTarget, string, error) {
	teamID := strings.TrimSpace(contact.SlackTeamID)
	if teamID != "" {
		if channelID := strings.TrimSpace(contact.SlackDMChannelID); channelID != "" {
			return slackbus.DeliveryTarget{TeamID: teamID, ChannelID: channelID}, "im", nil
		}
		channelIDs := append([]string(nil), contact.SlackChannelIDs...)
		sort.Slice(channelIDs, func(i, j int) bool { return channelIDs[i] < channelIDs[j] })
		for _, raw := range channelIDs {
			channelID := strings.TrimSpace(raw)
			if channelID == "" {
				continue
			}
			return slackbus.DeliveryTarget{
				TeamID:    teamID,
				ChannelID: channelID,
			}, slackChatTypeFromChannelID(channelID), nil
		}
	}
	if contactIDTeam, userOrChannelID, ok := parseSlackContactID(contact.ContactID); ok {
		idUpper := strings.ToUpper(userOrChannelID)
		if strings.HasPrefix(idUpper, "C") || strings.HasPrefix(idUpper, "G") || strings.HasPrefix(idUpper, "D") {
			return slackbus.DeliveryTarget{
				TeamID:    contactIDTeam,
				ChannelID: userOrChannelID,
			}, slackChatTypeFromChannelID(userOrChannelID), nil
		}
	}
	return slackbus.DeliveryTarget{}, "", fmt.Errorf("slack target not found in slack_dm_channel_id/slack_channel_ids/contact_id")
}

func ResolveSlackTargetWithChatID(contact contacts.Contact, chatIDHint string) (slackbus.DeliveryTarget, string, bool, error) {
	teamID, channelID, hasHint, err := parseSlackChatIDHint(chatIDHint)
	if err != nil {
		return slackbus.DeliveryTarget{}, "", hasHint, err
	}
	if hasHint {
		return slackbus.DeliveryTarget{
			TeamID:    teamID,
			ChannelID: channelID,
		}, slackChatTypeFromChannelID(channelID), true, nil
	}
	target, chatType, err := ResolveSlackTarget(contact)
	return target, chatType, false, err
}

func parseTelegramChatIDHint(raw string) (int64, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, false, nil
	}
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "tg:") {
		value = strings.TrimSpace(value[len("tg:"):])
	}
	chatID, err := strconv.ParseInt(value, 10, 64)
	if err != nil || chatID == 0 {
		return 0, false, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	return chatID, true, nil
}

func parseSlackChatIDHint(raw string) (string, string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", "", false, nil
	}
	if !strings.HasPrefix(strings.ToLower(value), "slack:") {
		return "", "", false, nil
	}
	parts := strings.Split(strings.TrimSpace(value[len("slack:"):]), ":")
	if len(parts) != 2 {
		return "", "", true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	teamID := strings.TrimSpace(parts[0])
	channelID := strings.TrimSpace(parts[1])
	if teamID == "" || channelID == "" {
		return "", "", true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	return teamID, channelID, true, nil
}

func parseSlackContactID(raw string) (string, string, bool) {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(value), "slack:") {
		return "", "", false
	}
	parts := strings.Split(strings.TrimSpace(value[len("slack:"):]), ":")
	if len(parts) != 2 {
		return "", "", false
	}
	teamID := strings.TrimSpace(parts[0])
	userOrChannelID := strings.TrimSpace(parts[1])
	if teamID == "" || userOrChannelID == "" {
		return "", "", false
	}
	return teamID, userOrChannelID, true
}

func contactTelegramChatMatch(contact contacts.Contact, chatID int64) (int64, string, bool) {
	if chatID == 0 {
		return 0, "", false
	}
	if contact.TGPrivateChatID == chatID {
		return chatID, "private", true
	}
	for _, groupID := range contact.TGGroupChatIDs {
		if groupID == chatID {
			return chatID, chatTypeFromChatID(chatID), true
		}
	}
	return 0, "", false
}

func slackChatTypeFromChannelID(channelID string) string {
	channelID = strings.ToUpper(strings.TrimSpace(channelID))
	switch {
	case strings.HasPrefix(channelID, "D"):
		return "im"
	case strings.HasPrefix(channelID, "G"):
		return "private_channel"
	default:
		return "channel"
	}
}

func IsPublicTelegramTarget(target any, resolvedChatType string) bool {
	chatType := strings.ToLower(strings.TrimSpace(resolvedChatType))
	if chatType == "group" || chatType == "supergroup" {
		return true
	}
	if chatType == "private" {
		return false
	}
	if id, ok := target.(int64); ok && id < 0 {
		return true
	}
	return false
}

func preferredChat(contact contacts.Contact) (int64, string, bool) {
	privateChatID := contact.TGPrivateChatID
	groupIDs := append([]int64(nil), contact.TGGroupChatIDs...)
	sort.Slice(groupIDs, func(i, j int) bool { return groupIDs[i] < groupIDs[j] })
	if privateChatID != 0 {
		return privateChatID, "private", true
	}
	for _, groupID := range groupIDs {
		if groupID != 0 {
			return groupID, chatTypeFromChatID(groupID), true
		}
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(contact.ContactID)), "tg:") && !strings.HasPrefix(strings.ToLower(strings.TrimSpace(contact.ContactID)), "tg:@") {
		idText := strings.TrimSpace(strings.TrimSpace(contact.ContactID)[len("tg:"):])
		if chatID, err := strconv.ParseInt(idText, 10, 64); err == nil && chatID != 0 {
			return chatID, chatTypeFromChatID(chatID), true
		}
	}
	return 0, "", false
}

func chatTypeFromChatID(chatID int64) string {
	if chatID < 0 {
		return "supergroup"
	}
	return "private"
}

func resolveContactMAEPPeerID(contact contacts.Contact) string {
	if _, peerID := splitMAEPNodeID(contact.MAEPNodeID); peerID != "" {
		return peerID
	}
	if _, peerID := splitMAEPNodeID(contact.ContactID); peerID != "" {
		return peerID
	}
	return ""
}

func splitMAEPNodeID(raw string) (string, string) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", ""
	}
	lower := strings.ToLower(value)
	if strings.Contains(value, ":") && !strings.HasPrefix(lower, "maep:") {
		return "", ""
	}
	if strings.HasPrefix(lower, "maep:") {
		peerID := strings.TrimSpace(value[len("maep:"):])
		if peerID == "" {
			return "", ""
		}
		return "maep:" + peerID, peerID
	}
	return "maep:" + value, value
}

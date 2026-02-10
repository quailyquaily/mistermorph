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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	maepbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/maep"
	telegrambus "github.com/quailyquaily/mistermorph/internal/bus/adapters/telegram"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/maep"
)

const defaultTelegramBaseURL = "https://api.telegram.org"

type SenderOptions struct {
	MAEPDir              string
	TelegramBotToken     string
	TelegramBaseURL      string
	AllowHumanSend       bool
	AllowHumanPublicSend bool
	BusMaxInFlight       int
	Logger               *slog.Logger
}

type RoutingSender struct {
	maepNode             *maep.Node
	bus                  *busruntime.Inproc
	telegramDelivery     *telegrambus.DeliveryAdapter
	maepDelivery         *maepbus.DeliveryAdapter
	telegramClient       *http.Client
	telegramBaseURL      string
	telegramBotToken     string
	allowHumanSend       bool
	allowHumanPublicSend bool
	pendingMu            sync.Mutex
	pending              map[string]chan deliveryResult
	closeOnce            sync.Once
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

	svc := maep.NewService(maep.NewFileStore(dir))
	node, err := maep.NewNode(ctx, svc, maep.NodeOptions{DialOnly: true, Logger: logger})
	if err != nil {
		return nil, err
	}

	baseURL := strings.TrimSpace(opts.TelegramBaseURL)
	if baseURL == "" {
		baseURL = defaultTelegramBaseURL
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
		_ = node.Close()
		return nil, err
	}

	sender := &RoutingSender{
		maepNode:             node,
		bus:                  inprocBus,
		telegramClient:       &http.Client{Timeout: 30 * time.Second},
		telegramBaseURL:      baseURL,
		telegramBotToken:     strings.TrimSpace(opts.TelegramBotToken),
		allowHumanSend:       opts.AllowHumanSend,
		allowHumanPublicSend: opts.AllowHumanPublicSend,
		pending:              make(map[string]chan deliveryResult),
	}
	sender.telegramDelivery, err = telegrambus.NewDeliveryAdapter(telegrambus.DeliveryAdapterOptions{
		SendText: sender.sendTelegramTarget,
	})
	if err != nil {
		_ = sender.Close()
		return nil, err
	}
	sender.maepDelivery, err = maepbus.NewDeliveryAdapter(maepbus.DeliveryAdapterOptions{
		Node: sender.maepNode,
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
		case busruntime.ChannelMAEP:
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

func (s *RoutingSender) Send(ctx context.Context, contact contacts.Contact, decision contacts.ShareDecision) (bool, bool, error) {
	if s == nil {
		return false, false, fmt.Errorf("nil routing sender")
	}
	if ctx == nil {
		return false, false, fmt.Errorf("context is required")
	}
	target, resolvedChatType, telegramErr := ResolveTelegramTarget(contact, decision)
	if telegramErr == nil && target != nil {
		if !s.allowHumanSend {
			return false, false, fmt.Errorf("human proactive send is disabled by config")
		}
		if !s.allowHumanPublicSend && IsPublicTelegramTarget(contact, decision, target, resolvedChatType) {
			return false, false, fmt.Errorf("public human proactive send is disabled by config")
		}
		return s.publishTelegram(ctx, target, decision)
	}
	if contact.Kind == contacts.KindHuman && telegramErr != nil {
		return false, false, telegramErr
	}
	return s.publishMAEP(ctx, contact, decision)
}

func (s *RoutingSender) publishMAEP(ctx context.Context, contact contacts.Contact, decision contacts.ShareDecision) (bool, bool, error) {
	if s == nil || s.bus == nil {
		return false, false, fmt.Errorf("sender bus is not configured")
	}
	peerID := strings.TrimSpace(decision.PeerID)
	if peerID == "" {
		peerID = strings.TrimSpace(contact.PeerID)
	}
	if peerID == "" {
		return false, false, fmt.Errorf("maep peer_id is required")
	}
	idempotencyKey := strings.TrimSpace(decision.IdempotencyKey)
	if idempotencyKey == "" {
		return false, false, fmt.Errorf("idempotency_key is required")
	}
	topic := strings.TrimSpace(decision.Topic)
	if topic == "" {
		topic = busruntime.TopicShareProactiveV1
	}
	now := time.Now().UTC()
	payloadRaw, err := buildEnvelopePayload(decision, topic, decision.ContentType, decision.PayloadBase64, now)
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
	topic := strings.TrimSpace(decision.Topic)
	if topic == "" {
		topic = busruntime.TopicShareProactiveV1
	}
	now := time.Now().UTC()
	payloadRaw, err := buildEnvelopePayload(decision, topic, decision.ContentType, decision.PayloadBase64, now)
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
		Topic:          strings.TrimSpace(decision.Topic),
		ContentType:    strings.TrimSpace(decision.ContentType),
		PayloadBase64:  strings.TrimSpace(decision.PayloadBase64),
		IdempotencyKey: strings.TrimSpace(decision.IdempotencyKey),
	}
	if req.Topic == "" {
		req.Topic = "share.proactive.v1"
	}
	envelopePayload, err := buildEnvelopePayload(decision, req.Topic, req.ContentType, req.PayloadBase64, now)
	if err != nil {
		return maep.DataPushRequest{}, err
	}
	req.ContentType = "application/json"
	req.PayloadBase64 = base64.RawURLEncoding.EncodeToString(envelopePayload)
	return req, nil
}

func buildEnvelopePayload(decision contacts.ShareDecision, topic string, contentType string, payloadBase64 string, now time.Time) ([]byte, error) {
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
	if maep.IsDialogueTopic(topic) && sessionID == "" {
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

func (s *RoutingSender) sendTelegramTarget(ctx context.Context, target any, text string) error {
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

func ResolveTelegramTarget(contact contacts.Contact, decision contacts.ShareDecision) (any, string, error) {
	if chatID, chatType, ok := preferredChatByDecision(contact, decision); ok {
		return chatID, chatType, nil
	}
	for _, raw := range []string{contact.SubjectID, contact.ContactID} {
		value := strings.TrimSpace(raw)
		lower := strings.ToLower(value)
		if strings.HasPrefix(lower, "tg:@") {
			continue
		}
		if strings.HasPrefix(lower, "tg:") {
			idText := strings.TrimSpace(value[len("tg:"):])
			chatID, err := strconv.ParseInt(idText, 10, 64)
			if err != nil {
				return nil, "", fmt.Errorf("invalid telegram id in %q", raw)
			}
			return chatID, "private", nil
		}
	}
	return nil, "", fmt.Errorf("telegram target not found in subject_id/contact_id")
}

func IsPublicTelegramTarget(contact contacts.Contact, decision contacts.ShareDecision, target any, resolvedChatType string) bool {
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
	if decision.SourceChatID != 0 {
		for _, item := range telegramChannelEndpoints(contact) {
			if item.ChatID != decision.SourceChatID {
				continue
			}
			t := strings.ToLower(strings.TrimSpace(item.ChatType))
			return t == "group" || t == "supergroup"
		}
	}
	t := strings.ToLower(strings.TrimSpace(decision.SourceChatType))
	return t == "group" || t == "supergroup"
}

func preferredChatByDecision(contact contacts.Contact, decision contacts.ShareDecision) (int64, string, bool) {
	chats := telegramChannelEndpoints(contact)
	if len(chats) == 0 {
		return 0, "", false
	}
	if decision.SourceChatID != 0 {
		for _, item := range chats {
			if item.ChatID == decision.SourceChatID {
				return item.ChatID, strings.ToLower(strings.TrimSpace(item.ChatType)), true
			}
		}
	}
	t := strings.ToLower(strings.TrimSpace(decision.SourceChatType))
	if t != "" {
		for _, item := range chats {
			if strings.ToLower(strings.TrimSpace(item.ChatType)) == t {
				return item.ChatID, t, true
			}
		}
	}
	for _, item := range chats {
		if strings.ToLower(strings.TrimSpace(item.ChatType)) == "private" {
			return item.ChatID, "private", true
		}
	}
	for _, item := range chats {
		if item.ChatID != 0 {
			return item.ChatID, strings.ToLower(strings.TrimSpace(item.ChatType)), true
		}
	}
	return 0, "", false
}

func telegramChannelEndpoints(contact contacts.Contact) []contacts.ChannelEndpoint {
	if len(contact.ChannelEndpoints) == 0 {
		return nil
	}
	out := make([]contacts.ChannelEndpoint, 0, len(contact.ChannelEndpoints))
	for _, item := range contact.ChannelEndpoints {
		if strings.ToLower(strings.TrimSpace(item.Channel)) != contacts.ChannelTelegram {
			continue
		}
		if item.ChatID == 0 {
			continue
		}
		out = append(out, item)
	}
	return out
}

func normalizeStrings(items []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(items))
	for _, raw := range items {
		item := strings.TrimSpace(raw)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

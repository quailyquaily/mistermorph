package telegramcmd

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/idempotency"
	"github.com/quailyquaily/mistermorph/internal/jsonutil"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/maepruntime"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/maep"
	"github.com/spf13/viper"
)

func splitCommand(text string) (cmd string, rest string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", ""
	}
	i := strings.IndexAny(text, " \n\t")
	if i == -1 {
		return text, ""
	}
	return text[:i], strings.TrimSpace(text[i:])
}

func normalizeSlashCommand(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" || !strings.HasPrefix(cmd, "/") {
		return ""
	}
	// Allow "/cmd@BotName" variants by stripping "@...".
	if at := strings.IndexByte(cmd, '@'); at >= 0 {
		cmd = cmd[:at]
	}
	return strings.ToLower(cmd)
}

type telegramGroupTriggerDecision struct {
	Reason            string
	UsedAddressingLLM bool

	AddressingLLMAttempted  bool
	AddressingLLMOK         bool
	AddressingLLMAddressed  bool
	AddressingLLMConfidence float64
	AddressingLLMInterject  float64
	AddressingImpulse       float64
}

func quoteReplyMessageIDForGroupTrigger(msg *telegramMessage, dec telegramGroupTriggerDecision) int64 {
	if msg == nil || msg.MessageID <= 0 {
		return 0
	}
	if dec.AddressingImpulse > 0.8 {
		return msg.MessageID
	}
	return 0
}

// groupTriggerDecision belongs to the trigger layer.
// It decides whether this group message should enter an agent run.
// It must not decide output modality (text reply vs reaction), which is handled in the generation layer.
func groupTriggerDecision(ctx context.Context, client llm.Client, model string, msg *telegramMessage, botUser string, botID int64, mode string, addressingLLMTimeout time.Duration, addressingConfidenceThreshold float64, addressingInterjectThreshold float64, history []chathistory.ChatHistoryItem) (telegramGroupTriggerDecision, bool, error) {
	if msg == nil {
		return telegramGroupTriggerDecision{}, false, nil
	}
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = "smart"
	}
	if addressingConfidenceThreshold <= 0 {
		addressingConfidenceThreshold = 0.6
	}
	if addressingConfidenceThreshold > 1 {
		addressingConfidenceThreshold = 1
	}
	if addressingInterjectThreshold <= 0 {
		addressingInterjectThreshold = 0.3
	}
	if addressingInterjectThreshold > 1 {
		addressingInterjectThreshold = 1
	}

	text := strings.TrimSpace(messageTextOrCaption(msg))
	explicitReason, explicitMentioned := groupExplicitMentionReason(msg, text, botUser, botID)
	if explicitMentioned {
		return telegramGroupTriggerDecision{
			Reason:            explicitReason,
			AddressingImpulse: 1,
		}, true, nil
	}

	runAddressingLLM := func(confidenceThreshold float64, interjectThreshold float64, requireAddressed bool, fallbackReason string) (telegramGroupTriggerDecision, bool, error) {
		dec := telegramGroupTriggerDecision{
			AddressingLLMAttempted: true,
			Reason:                 strings.TrimSpace(fallbackReason),
		}
		addrCtx := ctx
		if addrCtx == nil {
			addrCtx = context.Background()
		}
		cancel := func() {}
		if addressingLLMTimeout > 0 {
			addrCtx, cancel = context.WithTimeout(addrCtx, addressingLLMTimeout)
		}
		llmDec, llmOK, llmErr := addressingDecisionViaLLM(addrCtx, client, model, msg, text, history)
		cancel()
		if llmErr != nil {
			return dec, false, llmErr
		}
		dec.AddressingLLMOK = llmOK
		dec.AddressingLLMAddressed = llmDec.Addressed
		dec.AddressingLLMConfidence = llmDec.Confidence
		dec.AddressingLLMInterject = llmDec.Interject
		dec.AddressingImpulse = llmDec.Impulse
		if strings.TrimSpace(llmDec.Reason) != "" {
			dec.Reason = llmDec.Reason
		}
		addressedOK := true
		if requireAddressed {
			addressedOK = llmDec.Addressed
		}
		if llmOK && addressedOK && llmDec.Confidence >= confidenceThreshold && llmDec.Interject > interjectThreshold {
			dec.UsedAddressingLLM = true
			return dec, true, nil
		}
		return dec, false, nil
	}

	switch mode {
	case "talkative":
		return runAddressingLLM(addressingConfidenceThreshold, addressingInterjectThreshold, false, mode)
	case "smart":
		return runAddressingLLM(addressingConfidenceThreshold, addressingInterjectThreshold, true, mode)
	default: // strict (and unknown values fallback to strict behavior)
		return telegramGroupTriggerDecision{}, false, nil
	}
}

func groupExplicitMentionReason(msg *telegramMessage, text string, botUser string, botID int64) (string, bool) {
	// Reply-to-bot.
	if msg != nil && msg.ReplyTo != nil && msg.ReplyTo.From != nil && msg.ReplyTo.From.ID == botID {
		if text == "" && !messageHasDownloadableFile(msg) {
			return "", false
		}
		return "reply", true
	}
	return groupBodyMentionReason(msg, text, botUser, botID)
}

func groupBodyMentionReason(msg *telegramMessage, text string, botUser string, botID int64) (string, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false
	}

	// Entity-based mention of the bot (text_mention includes user id; mention includes "@username").
	if msg != nil {
		entities := msg.Entities
		if strings.TrimSpace(msg.Text) == "" && strings.TrimSpace(msg.Caption) != "" {
			entities = msg.CaptionEntities
		}
		for _, e := range entities {
			switch strings.ToLower(strings.TrimSpace(e.Type)) {
			case "text_mention":
				if e.User != nil && e.User.ID == botID {
					return "text_mention", true
				}
			case "mention":
				if botUser != "" {
					mention := sliceByUTF16(text, e.Offset, e.Length)
					if strings.EqualFold(mention, "@"+botUser) {
						return "mention_entity", true
					}
				}
			}
		}
	}

	// Fallback explicit @mention (some clients may omit entities).
	if botUser != "" && strings.Contains(strings.ToLower(text), "@"+strings.ToLower(botUser)) {
		return "at_mention", true
	}
	return "", false
}

func shouldSkipGroupReplyWithoutBodyMention(msg *telegramMessage, text string, botUser string, botID int64) bool {
	if msg == nil {
		return false
	}
	if msg.From != nil && msg.From.IsBot {
		return false
	}
	if msg.ReplyTo == nil {
		return false
	}
	if msg.ReplyTo.From != nil && msg.ReplyTo.From.ID == botID {
		return false
	}
	_, bodyMentioned := groupBodyMentionReason(msg, text, botUser, botID)
	return !bodyMentioned
}

func groupAliasMentionReason(text string, aliases []string, aliasPrefixMaxChars int) (string, bool) {
	if strings.TrimSpace(text) == "" {
		return "", false
	}
	if m, ok := matchAddressedAliasSmart(text, aliases, aliasPrefixMaxChars); ok {
		return "alias_smart:" + m.Alias, true
	}
	if hit, ok := anyAliasContains(text, aliases); ok {
		return "alias_mention:" + hit, true
	}
	return "", false
}

const mentionUserSnapshotLimit = 12

func collectMentionCandidates(msg *telegramMessage, botUser string) []string {
	if msg == nil {
		return nil
	}
	var out []string
	add := func(username string) {
		username = strings.TrimSpace(username)
		if username == "" {
			return
		}
		if strings.HasPrefix(username, "@") {
			username = strings.TrimSpace(username[1:])
		}
		if username == "" {
			return
		}
		if botUser != "" && strings.EqualFold(username, botUser) {
			return
		}
		out = append(out, "@"+username)
	}
	if msg.From != nil && !msg.From.IsBot {
		add(msg.From.Username)
	}
	if msg.ReplyTo != nil && msg.ReplyTo.From != nil && !msg.ReplyTo.From.IsBot {
		add(msg.ReplyTo.From.Username)
	}
	addEntities := func(text string, entities []telegramEntity) {
		if strings.TrimSpace(text) == "" || len(entities) == 0 {
			return
		}
		for _, e := range entities {
			switch strings.ToLower(strings.TrimSpace(e.Type)) {
			case "text_mention":
				if e.User != nil {
					add(e.User.Username)
				}
			case "mention":
				mention := strings.TrimSpace(sliceByUTF16(text, e.Offset, e.Length))
				if mention == "" {
					continue
				}
				add(strings.TrimPrefix(mention, "@"))
			}
		}
	}
	addEntities(msg.Text, msg.Entities)
	addEntities(msg.Caption, msg.CaptionEntities)
	return out
}

func addKnownUsernames(known map[int64]map[string]string, chatID int64, usernames []string) {
	if chatID == 0 || len(usernames) == 0 {
		return
	}
	set := known[chatID]
	if set == nil {
		set = make(map[string]string)
		known[chatID] = set
	}
	for _, username := range usernames {
		username = strings.TrimSpace(username)
		if username == "" {
			continue
		}
		if strings.HasPrefix(username, "@") {
			username = strings.TrimSpace(username[1:])
		}
		if username == "" {
			continue
		}
		key := strings.ToLower(username)
		if _, ok := set[key]; ok {
			continue
		}
		set[key] = "@" + username
	}
}

func mentionUsersSnapshot(known map[string]string, limit int) []string {
	if len(known) == 0 {
		return nil
	}
	out := make([]string, 0, len(known))
	for _, username := range known {
		out = append(out, username)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i]) < strings.ToLower(out[j])
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func isGroupChat(chatType string) bool {
	chatType = strings.ToLower(strings.TrimSpace(chatType))
	return chatType == "group" || chatType == "supergroup"
}

func shouldAutoReplyMAEPTopic(topic string) bool {
	return strings.TrimSpace(topic) != ""
}

func resolveMAEPReplyTopic(inboundTopic string) string {
	switch strings.ToLower(strings.TrimSpace(inboundTopic)) {
	case "dm.checkin.v1":
		return "dm.reply.v1"
	case "chat.message":
		return "chat.message"
	default:
		return "dm.reply.v1"
	}
}

func busErrorCodeString(err error) string {
	if err == nil {
		return ""
	}
	return string(busruntime.ErrorCodeOf(err))
}

func publishTelegramBusOutbound(ctx context.Context, inprocBus *busruntime.Inproc, chatID int64, text string, replyTo string, correlationID string) (string, error) {
	if inprocBus == nil {
		return "", fmt.Errorf("bus is required")
	}
	if ctx == nil {
		return "", fmt.Errorf("context is required")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("text is required")
	}
	replyTo = strings.TrimSpace(replyTo)
	now := time.Now().UTC()
	messageID := "msg_" + uuid.NewString()
	sessionUUID, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	sessionID := sessionUUID.String()
	payloadBase64, err := busruntime.EncodeMessageEnvelope(busruntime.TopicChatMessage, busruntime.MessageEnvelope{
		MessageID: messageID,
		Text:      text,
		SentAt:    now.Format(time.RFC3339),
		SessionID: sessionID,
		ReplyTo:   replyTo,
	})
	if err != nil {
		return "", err
	}
	conversationKey, err := busruntime.BuildTelegramChatConversationKey(strconv.FormatInt(chatID, 10))
	if err != nil {
		return "", err
	}
	correlationID = strings.TrimSpace(correlationID)
	if correlationID == "" {
		correlationID = "telegram:" + messageID
	}
	outbound := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionOutbound,
		Channel:         busruntime.ChannelTelegram,
		Topic:           busruntime.TopicChatMessage,
		ConversationKey: conversationKey,
		IdempotencyKey:  idempotency.MessageEnvelopeKey(messageID),
		CorrelationID:   correlationID,
		PayloadBase64:   payloadBase64,
		CreatedAt:       now,
		Extensions: busruntime.MessageExtensions{
			SessionID: sessionID,
			ReplyTo:   replyTo,
		},
	}
	if err := inprocBus.PublishValidated(ctx, outbound); err != nil {
		return "", err
	}
	return messageID, nil
}

func publishMAEPBusOutbound(ctx context.Context, inprocBus *busruntime.Inproc, peerID string, topic string, text string, sessionID string, replyTo string, correlationID string) (string, error) {
	if inprocBus == nil {
		return "", fmt.Errorf("bus is required")
	}
	if ctx == nil {
		return "", fmt.Errorf("context is required")
	}
	peerID = strings.TrimSpace(peerID)
	if peerID == "" {
		return "", fmt.Errorf("peer_id is required")
	}
	topic = strings.TrimSpace(topic)
	if topic == "" {
		return "", fmt.Errorf("topic is required")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("text is required")
	}
	sessionID = strings.TrimSpace(sessionID)
	replyTo = strings.TrimSpace(replyTo)
	now := time.Now().UTC()
	messageID := "msg_" + uuid.NewString()
	payloadBase64, err := busruntime.EncodeMessageEnvelope(topic, busruntime.MessageEnvelope{
		MessageID: messageID,
		Text:      text,
		SentAt:    now.Format(time.RFC3339),
		SessionID: sessionID,
		ReplyTo:   replyTo,
	})
	if err != nil {
		return "", err
	}
	conversationKey, err := busruntime.BuildMAEPPeerConversationKey(peerID)
	if err != nil {
		return "", err
	}
	correlationID = strings.TrimSpace(correlationID)
	if correlationID == "" {
		correlationID = "maep:" + messageID
	}
	outbound := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionOutbound,
		Channel:         busruntime.ChannelMAEP,
		Topic:           topic,
		ConversationKey: conversationKey,
		ParticipantKey:  peerID,
		IdempotencyKey:  idempotency.MessageEnvelopeKey(messageID),
		CorrelationID:   correlationID,
		PayloadBase64:   payloadBase64,
		CreatedAt:       now,
		Extensions: busruntime.MessageExtensions{
			SessionID: sessionID,
			ReplyTo:   replyTo,
		},
	}
	if err := inprocBus.PublishValidated(ctx, outbound); err != nil {
		return "", err
	}
	return messageID, nil
}

func extractMAEPTask(event maep.DataPushEvent) (string, string) {
	payload := event.PayloadBytes
	if len(payload) == 0 {
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(event.PayloadBase64))
		if err == nil {
			payload = decoded
		}
	}
	if len(payload) == 0 {
		return "", ""
	}
	contentType := strings.ToLower(strings.TrimSpace(event.ContentType))
	if strings.HasPrefix(contentType, "text/") {
		return strings.TrimSpace(string(payload)), strings.TrimSpace(event.SessionID)
	}
	if strings.HasPrefix(contentType, "application/json") {
		var obj map[string]any
		if err := json.Unmarshal(payload, &obj); err != nil {
			return strings.TrimSpace(string(payload)), ""
		}
		task := ""
		for _, key := range []string{"text", "message", "content", "prompt"} {
			if v, ok := obj[key].(string); ok && strings.TrimSpace(v) != "" {
				task = strings.TrimSpace(v)
				break
			}
		}
		sessionID := ""
		if v, ok := obj["session_id"].(string); ok {
			sessionID = strings.TrimSpace(v)
		}
		if sessionID == "" {
			sessionID = strings.TrimSpace(event.SessionID)
		}
		return task, sessionID
	}
	return "", ""
}

func classifyMAEPFeedback(ctx context.Context, client llm.Client, model string, history []llm.Message, inboundText string) (maepFeedbackClassification, error) {
	feedback := maepFeedbackClassification{
		NextAction: "continue",
		Confidence: 1,
	}
	if client == nil {
		return feedback, nil
	}
	model = strings.TrimSpace(model)
	if model == "" {
		return feedback, nil
	}
	inboundText = strings.TrimSpace(inboundText)
	if inboundText == "" {
		return feedback, nil
	}
	recent := history
	if len(recent) > 8 {
		recent = recent[len(recent)-8:]
	}
	systemPrompt, userPrompt, err := renderMAEPFeedbackPrompts(recent, inboundText)
	if err != nil {
		return feedback, fmt.Errorf("render maep feedback prompts: %w", err)
	}
	res, err := client.Chat(llminspect.WithModelScene(ctx, "maep.feedback_classify"), llm.Request{
		Model:     model,
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
		Parameters: map[string]any{
			"temperature": 0,
			"max_tokens":  400,
		},
	})
	if err != nil {
		return feedback, err
	}
	raw := strings.TrimSpace(res.Text)
	if raw == "" {
		return feedback, fmt.Errorf("empty feedback classification")
	}
	if err := jsonutil.DecodeWithFallback(raw, &feedback); err != nil {
		return feedback, err
	}
	return normalizeMAEPFeedback(feedback), nil
}

func normalizeMAEPFeedback(v maepFeedbackClassification) maepFeedbackClassification {
	v.SignalPositive = clampUnit(v.SignalPositive)
	v.SignalNegative = clampUnit(v.SignalNegative)
	v.SignalBored = clampUnit(v.SignalBored)
	v.Confidence = clampUnit(v.Confidence)
	v.NextAction = normalizeMAEPNextAction(v.NextAction)
	if v.NextAction == "" {
		v.NextAction = "continue"
	}
	return v
}

func normalizeMAEPNextAction(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "continue":
		return "continue"
	case "wrap_up":
		return "wrap_up"
	case "switch_topic":
		return "switch_topic"
	default:
		return ""
	}
}

func maepFeedbackTimeout(requestTimeout time.Duration) time.Duration {
	if requestTimeout > 0 {
		timeout := requestTimeout / 3
		if timeout < 3*time.Second {
			timeout = 3 * time.Second
		}
		if timeout > 15*time.Second {
			timeout = 15 * time.Second
		}
		return timeout
	}
	return 5 * time.Second
}

func maepPushTimeout(requestTimeout time.Duration) time.Duration {
	if requestTimeout > 0 {
		return requestTimeout
	}
	return 15 * time.Second
}

func configuredMAEPMaxTurnsPerSession() int {
	v := viper.GetInt("contacts.proactive.max_turns_per_session")
	if v <= 0 {
		return defaultMAEPMaxTurnsPerSession
	}
	return v
}

func configuredMAEPSessionCooldown() time.Duration {
	v := viper.GetDuration("contacts.proactive.session_cooldown")
	if v <= 0 {
		return defaultMAEPSessionCooldown
	}
	return v
}

func maepSessionKey(peerID string, topic string, sessionID string) string {
	p := strings.TrimSpace(peerID)
	if p == "" {
		p = "unknown"
	}
	s := strings.TrimSpace(sessionID)
	if s != "" {
		return p + "::session:" + s
	}
	return p + "::" + maepSessionScopeByTopic(topic)
}

func maepSessionScopeByTopic(topic string) string {
	return maep.SessionScopeByTopic(topic)
}

func cloneMAEPSessionStates(in map[string]maepSessionState) map[string]maepSessionState {
	if len(in) == 0 {
		return map[string]maepSessionState{}
	}
	out := make(map[string]maepSessionState, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func exportMAEPSessionStates(in map[string]maepSessionState) map[string]maepruntime.SessionState {
	if len(in) == 0 {
		return map[string]maepruntime.SessionState{}
	}
	out := make(map[string]maepruntime.SessionState, len(in))
	for key, value := range in {
		out[key] = maepruntime.SessionState{
			TurnCount:         value.TurnCount,
			CooldownUntil:     value.CooldownUntil,
			UpdatedAt:         value.UpdatedAt,
			InterestLevel:     value.InterestLevel,
			LowInterestRounds: value.LowInterestRounds,
			PreferenceSynced:  value.PreferenceSynced,
		}
	}
	return out
}

func restoreMAEPSessionStates(in map[string]maepruntime.SessionState) map[string]maepSessionState {
	if len(in) == 0 {
		return map[string]maepSessionState{}
	}
	out := make(map[string]maepSessionState, len(in))
	for key, value := range in {
		out[key] = maepSessionState{
			TurnCount:         value.TurnCount,
			CooldownUntil:     value.CooldownUntil,
			UpdatedAt:         value.UpdatedAt,
			InterestLevel:     value.InterestLevel,
			LowInterestRounds: value.LowInterestRounds,
			PreferenceSynced:  value.PreferenceSynced,
		}
	}
	return out
}

func applyMAEPFeedback(state maepSessionState, feedback maepFeedbackClassification) maepSessionState {
	state.InterestLevel = clampUnit(state.InterestLevel)
	if state.InterestLevel == 0 {
		state.InterestLevel = defaultMAEPInterestLevel
	}
	feedback = normalizeMAEPFeedback(feedback)
	next := state.InterestLevel + 0.35*feedback.SignalPositive - 0.30*feedback.SignalNegative - 0.10*feedback.SignalBored
	state.InterestLevel = clampUnit(next)
	if state.InterestLevel < maepInterestStopThreshold {
		state.LowInterestRounds++
	} else {
		state.LowInterestRounds = 0
	}
	return state
}

func maybeLimitMAEPSessionByFeedback(now time.Time, state maepSessionState, feedback maepFeedbackClassification, cooldown time.Duration) (maepSessionState, bool, string) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if cooldown <= 0 {
		cooldown = defaultMAEPSessionCooldown
	}
	feedback = normalizeMAEPFeedback(feedback)
	if feedback.NextAction == "wrap_up" && feedback.Confidence >= maepWrapUpConfidenceThreshold {
		state.CooldownUntil = now.Add(cooldown)
		state.UpdatedAt = now
		return state, true, "feedback_wrap_up"
	}
	if state.LowInterestRounds >= maepInterestLowRoundsLimit {
		state.CooldownUntil = now.Add(cooldown)
		state.UpdatedAt = now
		return state, true, "feedback_low_interest"
	}
	return state, false, ""
}

func allowMAEPSessionTurn(now time.Time, state maepSessionState, maxTurns int, cooldown time.Duration) (maepSessionState, bool) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if maxTurns <= 0 {
		maxTurns = defaultMAEPMaxTurnsPerSession
	}
	if cooldown <= 0 {
		cooldown = defaultMAEPSessionCooldown
	}

	if !state.CooldownUntil.IsZero() {
		if now.Before(state.CooldownUntil) {
			state.UpdatedAt = now
			return state, false
		}
		state.CooldownUntil = time.Time{}
		state.TurnCount = 0
		state.LowInterestRounds = 0
		state.InterestLevel = defaultMAEPInterestLevel
		state.PreferenceSynced = false
	}

	if state.TurnCount >= maxTurns {
		state.CooldownUntil = now.Add(cooldown)
		state.UpdatedAt = now
		return state, false
	}

	state.InterestLevel = clampUnit(state.InterestLevel)
	if state.InterestLevel == 0 {
		state.InterestLevel = defaultMAEPInterestLevel
	}
	if state.LowInterestRounds < 0 {
		state.LowInterestRounds = 0
	}
	state.UpdatedAt = now
	return state, true
}

func applyMAEPInboundFeedback(
	ctx context.Context,
	contactsSvc *contacts.Service,
	maepSvc *maep.Service,
	peerID string,
	inboundTopic string,
	sessionID string,
	feedback maepFeedbackClassification,
	now time.Time,
) error {
	_ = ctx
	_ = contactsSvc
	_ = maepSvc
	_ = peerID
	_ = inboundTopic
	_ = sessionID
	_ = feedback
	_ = now
	return nil
}

func applyTelegramInboundFeedback(
	ctx context.Context,
	svc *contacts.Service,
	chatID int64,
	chatType string,
	userID int64,
	username string,
	now time.Time,
) error {
	_ = ctx
	_ = svc
	_ = chatID
	_ = chatType
	_ = userID
	_ = username
	_ = now
	return nil
}

func clampUnit(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func telegramMemoryContactID(username string, userID int64) string {
	username = strings.TrimSpace(username)
	username = strings.TrimPrefix(username, "@")
	username = strings.TrimSpace(username)
	if username != "" {
		return "tg:@" + username
	}
	if userID > 0 {
		return fmt.Sprintf("tg:%d", userID)
	}
	return ""
}

func chooseBusinessContactID(nodeID string, peerID string) string {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID != "" {
		return nodeID
	}
	peerID = strings.TrimSpace(peerID)
	if peerID == "" {
		return ""
	}
	return "maep:" + peerID
}

func refreshMAEPPreferencesOnSessionEnd(
	ctx context.Context,
	contactsSvc *contacts.Service,
	maepSvc *maep.Service,
	client llm.Client,
	model string,
	peerID string,
	inboundTopic string,
	sessionID string,
	latestTask string,
	history []llm.Message,
	now time.Time,
	reason string,
) (bool, error) {
	_ = ctx
	_ = contactsSvc
	_ = maepSvc
	_ = client
	_ = model
	_ = peerID
	_ = inboundTopic
	_ = sessionID
	_ = latestTask
	_ = history
	_ = now
	_ = reason
	return false, nil
}

func lookupMAEPBusinessContact(ctx context.Context, maepSvc *maep.Service, contactsSvc *contacts.Service, peerID string) (contacts.Contact, bool, error) {
	if contactsSvc == nil {
		return contacts.Contact{}, false, nil
	}
	peerID = strings.TrimSpace(peerID)
	if peerID == "" {
		return contacts.Contact{}, false, nil
	}
	nodeID := ""
	if maepSvc != nil {
		item, ok, err := maepSvc.GetContactByPeerID(ctx, peerID)
		if err != nil {
			return contacts.Contact{}, false, err
		}
		if ok {
			nodeID = strings.TrimSpace(item.NodeID)
		}
	}
	ids := []string{chooseBusinessContactID(nodeID, peerID), "maep:" + peerID}
	seen := map[string]bool{}
	for _, raw := range ids {
		contactID := strings.TrimSpace(raw)
		if contactID == "" || seen[contactID] {
			continue
		}
		seen[contactID] = true
		contact, ok, err := contactsSvc.GetContact(ctx, contactID)
		if err != nil {
			return contacts.Contact{}, false, err
		}
		if ok {
			return contact, true, nil
		}
	}
	return contacts.Contact{}, false, nil
}

const (
	telegramHistoryCapTalkative = 16
	telegramHistoryCapDefault   = 8
	telegramStickySkillsCap     = 3
)

func telegramHistoryCapForMode(mode string) int {
	if strings.EqualFold(strings.TrimSpace(mode), "talkative") {
		return telegramHistoryCapTalkative
	}
	return telegramHistoryCapDefault
}

func trimChatHistoryItems(items []chathistory.ChatHistoryItem, max int) []chathistory.ChatHistoryItem {
	if max <= 0 || len(items) <= max {
		return items
	}
	return items[len(items)-max:]
}

var telegramAtMentionPattern = regexp.MustCompile(`@[A-Za-z0-9_]{3,64}`)

func formatTelegramPersonReference(nickname string, username string) string {
	username = strings.TrimPrefix(strings.TrimSpace(username), "@")
	nickname = sanitizeTelegramReferenceLabel(nickname)
	if nickname == "" {
		nickname = username
	}
	if nickname == "" {
		return ""
	}
	if username == "" {
		return nickname
	}
	return "[" + nickname + "](tg:@" + username + ")"
}

func sanitizeTelegramReferenceLabel(label string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		return ""
	}
	label = strings.ReplaceAll(label, "[", "")
	label = strings.ReplaceAll(label, "]", "")
	label = strings.ReplaceAll(label, "(", "")
	label = strings.ReplaceAll(label, ")", "")
	label = strings.Join(strings.Fields(label), " ")
	return strings.TrimSpace(label)
}

func formatTelegramAtMentionsForHistory(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	matches := telegramAtMentionPattern.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var out strings.Builder
	out.Grow(len(text) + len(matches)*12)
	last := 0
	for _, m := range matches {
		start, end := m[0], m[1]
		if start < last || start < 0 || end > len(text) || start >= end {
			continue
		}
		username := strings.TrimPrefix(text[start:end], "@")
		lower := strings.ToLower(text)
		if start >= 4 && lower[start-4:start] == "tg:@" {
			continue
		}
		out.WriteString(text[last:start])
		ref := formatTelegramPersonReference(username, username)
		if ref == "" {
			out.WriteString(text[start:end])
		} else {
			out.WriteString(ref)
		}
		last = end
	}
	out.WriteString(text[last:])
	return strings.TrimSpace(out.String())
}

func ensureMarkdownBlockquote(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	for i := range lines {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			lines[i] = ">"
			continue
		}
		if strings.HasPrefix(line, ">") {
			lines[i] = line
			continue
		}
		lines[i] = "> " + line
	}
	return strings.Join(lines, "\n")
}

func stripMarkdownBlockquote(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	for i := range lines {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, ">") {
			line = strings.TrimSpace(strings.TrimPrefix(line, ">"))
		}
		lines[i] = line
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func extractQuoteSenderRef(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	firstLine := text
	if idx := strings.Index(firstLine, "\n"); idx >= 0 {
		firstLine = firstLine[:idx]
	}
	firstLine = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(firstLine), ">"))
	if firstLine == "" {
		return ""
	}
	end := strings.Index(firstLine, ")")
	if end <= 0 {
		return ""
	}
	candidate := strings.TrimSpace(firstLine[:end+1])
	if strings.HasPrefix(candidate, "[") && strings.Contains(candidate, "](tg:@") {
		return candidate
	}
	return ""
}

func splitTaskQuoteForHistory(task string) (string, *chathistory.ChatHistoryQuote) {
	task = strings.TrimSpace(task)
	if task == "" {
		return "", nil
	}
	const (
		prefix = "Quoted message:\n"
		sep    = "\n\nUser request:\n"
	)
	if !strings.HasPrefix(task, prefix) {
		return task, nil
	}
	rest := strings.TrimPrefix(task, prefix)
	idx := strings.Index(rest, sep)
	if idx < 0 {
		return task, nil
	}
	quoteRaw := strings.TrimSpace(rest[:idx])
	mainText := strings.TrimSpace(rest[idx+len(sep):])
	quoteRaw = formatTelegramAtMentionsForHistory(quoteRaw)
	block := ensureMarkdownBlockquote(quoteRaw)
	if block == "" {
		return mainText, nil
	}
	return mainText, &chathistory.ChatHistoryQuote{
		SenderRef:     extractQuoteSenderRef(block),
		Text:          stripMarkdownBlockquote(block),
		MarkdownBlock: block,
	}
}

func telegramSenderFromJob(job telegramJob) chathistory.ChatHistorySender {
	username := strings.TrimPrefix(strings.TrimSpace(job.FromUsername), "@")
	nickname := strings.TrimSpace(job.FromDisplayName)
	if nickname == "" {
		first := strings.TrimSpace(job.FromFirstName)
		last := strings.TrimSpace(job.FromLastName)
		switch {
		case first != "" && last != "":
			nickname = first + " " + last
		case first != "":
			nickname = first
		case last != "":
			nickname = last
		default:
			nickname = username
		}
	}
	return chathistory.ChatHistorySender{
		UserID:     strconv.FormatInt(job.FromUserID, 10),
		Username:   username,
		Nickname:   nickname,
		DisplayRef: formatTelegramPersonReference(nickname, username),
	}
}

func newTelegramInboundHistoryItem(job telegramJob) chathistory.ChatHistoryItem {
	sentAt := job.SentAt.UTC()
	if sentAt.IsZero() {
		sentAt = time.Now().UTC()
	}
	text, quote := splitTaskQuoteForHistory(job.Text)
	text = formatTelegramAtMentionsForHistory(text)
	if text == "" {
		text = "(empty)"
	}
	messageID := ""
	if job.MessageID > 0 {
		messageID = strconv.FormatInt(job.MessageID, 10)
	}
	replyToMessageID := ""
	if job.ReplyToMessageID > 0 {
		replyToMessageID = strconv.FormatInt(job.ReplyToMessageID, 10)
	}
	return chathistory.ChatHistoryItem{
		Channel:          chathistory.ChannelTelegram,
		Kind:             chathistory.KindInboundUser,
		ChatID:           strconv.FormatInt(job.ChatID, 10),
		ChatType:         strings.TrimSpace(job.ChatType),
		MessageID:        messageID,
		ReplyToMessageID: replyToMessageID,
		SentAt:           sentAt,
		Sender:           telegramSenderFromJob(job),
		Text:             text,
		Quote:            quote,
	}
}

func newTelegramOutboundAgentHistoryItem(chatID int64, chatType string, text string, sentAt time.Time, botUser string) chathistory.ChatHistoryItem {
	if sentAt.IsZero() {
		sentAt = time.Now().UTC()
	}
	botUser = strings.TrimPrefix(strings.TrimSpace(botUser), "@")
	nickname := botUser
	if nickname == "" {
		nickname = "MisterMorph"
	}
	text = strings.TrimSpace(text)
	if text == "" {
		text = "(empty)"
	}
	return chathistory.ChatHistoryItem{
		Channel:  chathistory.ChannelTelegram,
		Kind:     chathistory.KindOutboundAgent,
		ChatID:   strconv.FormatInt(chatID, 10),
		ChatType: strings.TrimSpace(chatType),
		SentAt:   sentAt.UTC(),
		Sender: chathistory.ChatHistorySender{
			Username:   botUser,
			Nickname:   nickname,
			IsBot:      true,
			DisplayRef: formatTelegramPersonReference(nickname, botUser),
		},
		Text: text,
	}
}

func newTelegramOutboundReactionHistoryItem(chatID int64, chatType string, note string, emoji string, sentAt time.Time, botUser string) chathistory.ChatHistoryItem {
	item := newTelegramOutboundAgentHistoryItem(chatID, chatType, note, sentAt, botUser)
	item.Kind = chathistory.KindOutboundReaction
	if strings.TrimSpace(emoji) != "" {
		item.Text = strings.TrimSpace(note)
	}
	return item
}

func newTelegramSystemHistoryItem(chatID int64, chatType string, text string, sentAt time.Time, botUser string) chathistory.ChatHistoryItem {
	item := newTelegramOutboundAgentHistoryItem(chatID, chatType, text, sentAt, botUser)
	item.Kind = chathistory.KindSystem
	return item
}

func collectMAEPUserUtterances(history []llm.Message, latestTask string) []string {
	values := make([]string, 0, len(history)+1)
	for _, msg := range history {
		if strings.ToLower(strings.TrimSpace(msg.Role)) != "user" {
			continue
		}
		text := strings.TrimSpace(msg.Content)
		if text == "" {
			continue
		}
		values = append(values, text)
	}
	if text := strings.TrimSpace(latestTask); text != "" {
		values = append(values, text)
	}
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, raw := range values {
		text := strings.TrimSpace(raw)
		if text == "" {
			continue
		}
		out = append(out, text)
	}
	return out
}

func dedupeNonEmptyStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, raw := range values {
		v := strings.TrimSpace(raw)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func stripBotMentions(text, botUser string) string {
	text = strings.TrimSpace(text)
	if text == "" || botUser == "" {
		return text
	}
	mention := "@" + botUser
	// Remove common mention patterns (case-insensitive).
	lower := strings.ToLower(text)
	idx := strings.Index(lower, strings.ToLower(mention))
	if idx >= 0 {
		text = strings.TrimSpace(text[:idx] + text[idx+len(mention):])
	}
	return strings.TrimSpace(text)
}

func truncateOneLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return `""`
	}
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\t", " ")
	s = strings.Join(strings.Fields(s), " ")
	if max <= 0 || len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-3] + "..."
}

func buildReplyContext(msg *telegramMessage) string {
	if msg == nil {
		return ""
	}
	text := strings.TrimSpace(messageTextOrCaption(msg))
	if text == "" && messageHasDownloadableFile(msg) {
		text = "[attachment]"
	}
	if text == "" {
		return ""
	}
	text = truncateRunes(text, 2000)
	if msg.From != nil && strings.TrimSpace(msg.From.Username) != "" {
		return "@" + strings.TrimSpace(msg.From.Username) + ": " + text
	}
	return text
}

func truncateRunes(s string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" || max <= 0 {
		return s
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 3 {
		return string(runes[:max])
	}
	return string(runes[:max-3]) + "..."
}

type telegramAliasSmartMatch struct {
	Alias    string
	TaskText string
}

func matchAddressedAliasSmart(text string, aliases []string, aliasPrefixMaxChars int) (telegramAliasSmartMatch, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return telegramAliasSmartMatch{}, false
	}
	if aliasPrefixMaxChars <= 0 {
		aliasPrefixMaxChars = 24
	}

	prefixStart := skipLeadingAddressingJunk(text)

	bestIdx := -1
	best := telegramAliasSmartMatch{}

	for _, alias := range aliases {
		alias = strings.TrimSpace(alias)
		if alias == "" {
			continue
		}

		searchFrom := 0
		for {
			idx := indexOfAlias(text, alias, searchFrom)
			if idx < 0 {
				break
			}
			searchFrom = idx + 1

			if idx < prefixStart {
				continue
			}
			if !isAliasAddressingCandidate(text, prefixStart, idx, aliasPrefixMaxChars) {
				continue
			}

			after := idx + len(alias)
			if after < 0 || after > len(text) {
				continue
			}
			rest := trimLeadingSeparators(text[after:])
			if rest == "" {
				continue
			}
			if !looksLikeRequest(rest) {
				continue
			}

			if bestIdx < 0 || idx < bestIdx {
				bestIdx = idx
				best = telegramAliasSmartMatch{Alias: alias, TaskText: rest}
			}
		}
	}

	if bestIdx < 0 {
		return telegramAliasSmartMatch{}, false
	}
	return best, true
}

func anyAliasContains(text string, aliases []string) (string, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false
	}
	for _, alias := range aliases {
		alias = strings.TrimSpace(alias)
		if alias == "" {
			continue
		}
		if indexOfAlias(text, alias, 0) >= 0 {
			return alias, true
		}
	}
	return "", false
}

func isAliasAddressingCandidate(text string, prefixStart int, aliasIdx int, aliasPrefixMaxChars int) bool {
	if aliasIdx < 0 || aliasIdx > len(text) {
		return false
	}
	if prefixStart < 0 {
		prefixStart = 0
	}
	if prefixStart > aliasIdx {
		return false
	}

	prefix := text[prefixStart:aliasIdx]
	if aliasPrefixMaxChars > 0 && utf8.RuneCountInString(prefix) > aliasPrefixMaxChars {
		return false
	}

	prefixTrim := strings.TrimSpace(prefix)
	if prefixTrim == "" {
		return true
	}
	return looksLikeGreeting(prefixTrim)
}

func looksLikeGreeting(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	s = strings.ToLower(s)
	s = strings.Trim(s, " \t\r\n,.;:!?，。！？：；、-—()[]{}<>\"'")
	switch s {
	case "hi", "hey", "yo", "hello", "sup", "hola", "bonjour", "ciao", "嗨", "你好", "哈喽", "喂":
		return true
	default:
		return false
	}
}

func looksLikeRequest(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	if strings.ContainsAny(s, "？?") {
		return true
	}

	lower := strings.ToLower(s)
	for _, p := range []string{
		"please", "pls", "plz",
		"help", "can you", "could you", "would you",
		"tell me", "explain", "summarize", "translate", "write",
		"generate", "make", "create", "list", "show",
		"why", "how", "what",
	} {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}

	for _, p := range []string{
		"请", "麻烦", "帮", "帮我", "能不能", "可以", "能否",
		"给我", "告诉我", "解释", "总结", "列出", "写", "生成", "翻译",
		"查", "看", "做", "分析", "推荐", "对比",
		"为什么", "怎么", "如何", "是什么",
	} {
		if strings.HasPrefix(s, p) || strings.Contains(s, p) {
			return true
		}
	}

	return false
}

func trimLeadingSeparators(s string) string {
	s = strings.TrimSpace(s)
	for s != "" {
		r, size := utf8.DecodeRuneInString(s)
		if r == utf8.RuneError && size == 1 {
			break
		}
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			s = strings.TrimSpace(s[size:])
			continue
		}
		break
	}
	return strings.TrimSpace(s)
}

func skipLeadingAddressingJunk(s string) int {
	i := 0
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			return i
		}
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			i += size
			continue
		}
		break
	}
	return i
}

func sliceByUTF16(s string, offset, length int) string {
	if offset < 0 {
		offset = 0
	}
	if length <= 0 || s == "" {
		return ""
	}
	start := utf16OffsetToByteIndex(s, offset)
	end := utf16OffsetToByteIndex(s, offset+length)
	if start < 0 {
		start = 0
	}
	if end > len(s) {
		end = len(s)
	}
	if start > end {
		return ""
	}
	return s[start:end]
}

func utf16OffsetToByteIndex(s string, offset int) int {
	if offset <= 0 {
		return 0
	}
	utf16Count := 0
	for i, r := range s {
		if utf16Count >= offset {
			return i
		}
		if r <= 0xFFFF {
			utf16Count++
		} else {
			utf16Count += 2
		}
	}
	return len(s)
}

func indexOfAlias(text, alias string, start int) int {
	if start < 0 {
		start = 0
	}
	if start >= len(text) {
		return -1
	}
	if alias == "" {
		return -1
	}
	if isASCII(alias) {
		return indexFoldASCII(text, alias, start)
	}
	if i := strings.Index(text[start:], alias); i >= 0 {
		return start + i
	}
	return -1
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

func indexFoldASCII(text, sub string, start int) int {
	if start < 0 {
		start = 0
	}
	if len(sub) == 0 {
		return -1
	}
	if start+len(sub) > len(text) {
		return -1
	}

	needle := make([]byte, len(sub))
	for i := 0; i < len(sub); i++ {
		needle[i] = lowerASCII(sub[i])
	}

	hay := []byte(text)
	for i := start; i+len(needle) <= len(hay); i++ {
		ok := true
		for j := range len(needle) {
			if lowerASCII(hay[i+j]) != needle[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

func lowerASCII(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

type telegramAddressingLLMDecision struct {
	Addressed  bool    `json:"addressed"`
	Confidence float64 `json:"confidence"`
	Interject  float64 `json:"interject"`
	Impulse    float64 `json:"impulse"`
	Reason     string  `json:"reason"`
}

func addressingDecisionViaLLM(ctx context.Context, client llm.Client, model string, msg *telegramMessage, text string, history []chathistory.ChatHistoryItem) (telegramAddressingLLMDecision, bool, error) {
	if ctx == nil || client == nil {
		return telegramAddressingLLMDecision{}, false, nil
	}
	text = strings.TrimSpace(text)
	model = strings.TrimSpace(model)
	if model == "" {
		return telegramAddressingLLMDecision{}, false, fmt.Errorf("missing model for addressing_llm")
	}

	historyMessages := chathistory.BuildMessages(chathistory.ChannelTelegram, history)
	currentMessage := telegramAddressingPromptCurrentMessage{
		Text: text,
	}
	if msg != nil {
		if msg.From != nil {
			currentMessage.Sender.ID = msg.From.ID
			currentMessage.Sender.IsBot = msg.From.IsBot
			currentMessage.Sender.Username = strings.TrimSpace(msg.From.Username)
			currentMessage.Sender.DisplayName = strings.TrimSpace(telegramDisplayName(msg.From))
		}
		if msg.Chat != nil {
			currentMessage.Sender.ChatID = msg.Chat.ID
			currentMessage.Sender.ChatType = strings.TrimSpace(msg.Chat.Type)
		}
	}
	sys, user, err := renderTelegramAddressingPrompts(currentMessage, historyMessages)
	if err != nil {
		return telegramAddressingLLMDecision{}, false, fmt.Errorf("render addressing prompts: %w", err)
	}

	res, err := client.Chat(llminspect.WithModelScene(ctx, "telegram.addressing_decision"), llm.Request{
		Model:     model,
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: sys},
			{Role: "user", Content: user},
		},
	})
	if err != nil {
		return telegramAddressingLLMDecision{}, false, err
	}

	raw := strings.TrimSpace(res.Text)
	if raw == "" {
		return telegramAddressingLLMDecision{}, false, fmt.Errorf("empty addressing_llm response")
	}

	var out telegramAddressingLLMDecision
	if err := jsonutil.DecodeWithFallback(raw, &out); err != nil {
		return telegramAddressingLLMDecision{}, false, fmt.Errorf("invalid addressing_llm json")
	}

	if out.Confidence < 0 {
		out.Confidence = 0
	}
	if out.Confidence > 1 {
		out.Confidence = 1
	}
	if out.Impulse < 0 {
		out.Impulse = 0
	}
	if out.Impulse > 1 {
		out.Impulse = 1
	}
	if out.Interject < 0 {
		out.Interject = 0
	}
	if out.Interject > 1 {
		out.Interject = 1
	}
	out.Reason = strings.TrimSpace(out.Reason)
	return out, true, nil
}

func (api *telegramAPI) sendChatAction(ctx context.Context, chatID int64, action string) error {
	action = strings.TrimSpace(action)
	if action == "" {
		action = "typing"
	}
	reqBody := telegramSendChatActionRequest{ChatID: chatID, Action: action}
	b, _ := json.Marshal(reqBody)
	url := fmt.Sprintf("%s/bot%s/sendChatAction", api.baseURL, api.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := api.http.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func startTypingTicker(ctx context.Context, api *telegramAPI, chatID int64, action string, interval time.Duration) func() {
	if ctx == nil {
		ctx = context.Background()
	}
	if api == nil || chatID == 0 {
		return func() {}
	}
	if interval <= 0 {
		interval = 4 * time.Second
	}
	action = strings.TrimSpace(action)
	if action == "" {
		action = "typing"
	}

	ticker := time.NewTicker(interval)
	done := make(chan struct{})

	go func() {
		_ = api.sendChatAction(ctx, chatID, action)
		for {
			select {
			case <-ticker.C:
				_ = api.sendChatAction(ctx, chatID, action)
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	return func() {
		select {
		case <-done:
		default:
			close(done)
		}
		ticker.Stop()
	}
}

type telegramDownloadedFile struct {
	Kind         string
	OriginalName string
	MimeType     string
	SizeBytes    int64
	Path         string
}

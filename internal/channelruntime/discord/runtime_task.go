package discord

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/imageinput"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
	"github.com/quailyquaily/mistermorph/internal/idempotency"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/todo"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
	discordtools "github.com/quailyquaily/mistermorph/tools/discord"
)

const (
	discordStickySkillsCap = 16
	discordHistoryLimit    = 8
)

type discordJob struct {
	TaskID           string
	ConversationKey  string
	ChannelID        string
	GuildID          string
	ChatType         string
	MessageID        string
	ReplyToMessageID string
	UserID           string
	Username         string
	DisplayName      string
	FromIsAgent      bool
	Text             string
	ImagePaths       []string
	Images           []chathistory.ChatHistoryImage
	WorkspaceDir     string
	FileCacheDir     string
	Route            *llmutil.ResolvedRoute
	ResumeApprovalID string
	SentAt           time.Time
	Version          uint64
	MentionUsers     []string
	EventID          string
	// FromInteraction marks a slash command; MessageID is then its interaction ID.
	FromInteraction bool
	Generation      *runtimecore.RuntimeGenerationLease
}

func (j discordJob) runtimeBundle() *runtimecore.ChannelRuntimeBundle {
	if j.Generation == nil {
		return nil
	}
	return j.Generation.Bundle()
}

func (j discordJob) releaseGeneration() {
	if j.Generation != nil {
		j.Generation.Release()
	}
}

func (j discordJob) approvalGuard() *guard.Guard {
	bundle := j.runtimeBundle()
	if bundle == nil || bundle.TaskRuntime == nil {
		return nil
	}
	return bundle.TaskRuntime.SharedGuard
}

func (j discordJob) isGroup() bool {
	return j.ChatType == discordbus.ChatTypeGroup
}

// replyTarget is the message an answer replies to: the triggering one in servers, none in DMs, and
// a slash command's placeholder anywhere.
func (j discordJob) replyTarget() string {
	if j.isGroup() || j.FromInteraction {
		return strings.TrimSpace(j.MessageID)
	}
	return ""
}

func discordJobFromInbound(inbound discordbus.InboundMessage) discordJob {
	return discordJob{
		ChannelID: inbound.ChannelID, GuildID: inbound.GuildID, ChatType: inbound.ChatType, MessageID: inbound.MessageID,
		ReplyToMessageID: inbound.ReplyToMessageID, UserID: inbound.UserID, Username: inbound.Username,
		DisplayName: inbound.DisplayName, FromIsAgent: inbound.FromIsAgent, Text: inbound.Text, SentAt: inbound.SentAt.UTC(),
		ImagePaths:   busruntime.ImagePathsFromAttachments(inbound.ImageAttachments),
		MentionUsers: append([]string(nil), inbound.MentionUserIDs...), EventID: inbound.MessageID,
	}
}

func discordTaskConversation(job discordJob, botID string) *taskdomain.TaskConversation {
	return runtimecore.BuildTaskConversation(job.ConversationKey, job.ChatType, job.UserID, job.DisplayName, botID, job.MentionUsers)
}

// discordTaskResult is what a run left for the reply and the history.
type discordTaskResult struct {
	Final        *agent.Final
	Context      *agent.Context
	LoadedSkills []string
	Reaction     *discordtools.Reaction
}

type discordTaskEnv struct {
	api       discordAPI
	bus       *busruntime.Inproc
	receipts  *discordDeliveryReceipts
	logger    *slog.Logger
	botID     string
	botName   string
	fileLimit int64
}

func runDiscordTask(ctx context.Context, rt *taskruntime.Runtime, env discordTaskEnv, job discordJob, history []chathistory.ChatHistoryItem, stickySkills []string, steerSource agent.SteerSource) (discordTaskResult, error) {
	if rt == nil {
		return discordTaskResult{}, fmt.Errorf("discord task runtime is nil")
	}
	ctx = llmstats.WithMetadata(ctx, job.TaskID, job.EventID)
	ctx = topiccontext.WithScope(ctx, topiccontext.Scope{Runtime: "discord", ConversationKey: job.ConversationKey, TopicID: job.ChannelID})
	ctx = pathroots.WithWorkspaceDir(ctx, job.WorkspaceDir)
	ctx = builtin.WithContactsSendRuntimeContext(ctx, contactsSendRuntimeContextForDiscord(job))
	task := strings.TrimSpace(job.Text)
	routePurpose := ""
	reasoningEffort := ""
	if thinkTask, ok := chatcommands.ExtractThinkTask(task); ok {
		task = strings.TrimSpace(thinkTask)
		job.Text = task
		routePurpose = llmutil.RoutePurposeThink
		reasoningEffort = llmutil.ReasoningEffortXHigh
	}
	if task == "" {
		return discordTaskResult{}, fmt.Errorf("empty discord task")
	}
	var mainRoute llmutil.ResolvedRoute
	if job.Route != nil {
		mainRoute = *job.Route
	} else {
		resolved, err := rt.ResolveRouteForRun(ctx, routePurpose)
		if err != nil {
			return discordTaskResult{}, err
		}
		mainRoute = resolved
	}
	if reasoningEffort != "" {
		mainRoute = llmutil.ResolvedRouteWithReasoningEffort(mainRoute, reasoningEffort)
	}
	checkpoint, err := rt.PrepareContextHistory(ctx, job.ConversationKey, history, newDiscordInboundHistoryItem(job))
	if err != nil {
		return discordTaskResult{}, err
	}
	historyMessages, currentMessage, err := buildDiscordPromptMessages(checkpoint.History, job, strings.TrimSpace(mainRoute.ClientConfig.Model), mainRoute.Values.SupportsImageParts, rt.Logger)
	if err != nil {
		return discordTaskResult{}, err
	}
	registry := buildDiscordRegistry(rt.BaseRegistry, job.ChatType)
	var reactTool *discordtools.ReactTool
	if env.api != nil {
		toolAPI := discordToolAPI{api: env.api}
		reactTool = discordtools.NewReactTool(toolAPI, job.ChannelID, job.MessageID)
		for _, tool := range []tools.Tool{reactTool, discordtools.NewSendFileTool(toolAPI, job.ChannelID, job.replyTarget(), job.FileCacheDir, env.fileLimit)} {
			if err := registry.Replace(tool); err != nil {
				return discordTaskResult{}, err
			}
		}
	}
	progress := &discordPlanProgress{api: env.api, channelID: job.ChannelID, replyTo: job.replyTarget(), logger: env.logger}
	planStepUpdate := func(runCtx *agent.Context, update agent.PlanStepUpdate) {
		if runCtx == nil || runCtx.Plan == nil {
			return
		}
		if note := strings.TrimSpace(update.CompletedNote); note != "" {
			correlationID := fmt.Sprintf("discord:step:%s:%d", job.TaskID, update.CompletedIndex)
			if _, err := publishDiscordBusOutboundAndWait(ctx, env.bus, env.receipts, job.ChannelID, note, "", correlationID); err != nil {
				env.logger.Warn("discord_plan_step_send_failed", "channel_id", job.ChannelID, "task_id", job.TaskID, "error", err.Error())
			}
		}
		progress.update(ctx, runCtx.Plan)
	}
	meta := taskruntime.ApplyObservationMeta(map[string]any{
		"trigger":              "discord",
		"discord_channel_id":   job.ChannelID,
		"discord_guild_id":     job.GuildID,
		"discord_chat_type":    job.ChatType,
		"discord_user_id":      job.UserID,
		"discord_message_id":   job.MessageID,
		"discord_conversation": job.ConversationKey,
	}, taskruntime.ObservationMetaIDs{TaskID: job.TaskID, TraceID: job.TaskID, TopicID: job.ChannelID, OriginEventID: job.EventID})
	runRequest := taskruntime.RunRequest{
		Task:                    task,
		Model:                   strings.TrimSpace(mainRoute.ClientConfig.Model),
		Route:                   &mainRoute,
		RoutePurpose:            routePurpose,
		ReasoningEffortOverride: reasoningEffort,
		Scene:                   "discord.loop",
		History:                 historyMessages,
		CurrentMessage:          currentMessage,
		Meta:                    meta,
		StickySkills:            stickySkills,
		Registry:                registry,
		PromptAugment: func(spec *agent.PromptSpec, reg *tools.Registry) {
			if block := workspace.PromptBlock(job.WorkspaceDir); strings.TrimSpace(block.Content) != "" {
				spec.Blocks = append([]agent.PromptBlock{block}, spec.Blocks...)
			}
			toolsutil.SetTodoUpdateToolAddContext(reg, todoResolveContextForDiscord(job))
			promptprofile.AppendDiscordRuntimeBlocks(spec, job.isGroup())
		},
		PlanStepUpdate:         planStepUpdate,
		SteerSource:            steerSource,
		ImageToolScope:         strings.TrimSpace(job.ConversationKey),
		ImageToolRetention:     toolsutil.ImageToolRetentionCountdown,
		ContextCheckpointStore: checkpoint.Store,
		HistoryBoundaries:      checkpoint.HistoryBoundaries,
		CurrentMessageBoundary: checkpoint.CurrentMessageBoundary,
	}
	if job.FromIsAgent && !job.isGroup() {
		runRequest.ToolTriggers = map[string]bool{toolsutil.BuiltinContactsSend: true}
	}
	var result taskruntime.RunResult
	if approvalID := strings.TrimSpace(job.ResumeApprovalID); approvalID != "" {
		result, err = rt.Resume(ctx, approvalID, runRequest)
	} else {
		result, err = rt.Run(ctx, runRequest)
	}
	out := discordTaskResult{Final: result.Final, Context: result.Context, LoadedSkills: result.LoadedSkills}
	if reactTool != nil {
		out.Reaction = reactTool.LastReaction()
	}
	return out, err
}

// discordPlanProgress keeps one message showing the plan, sent with the first update and edited in
// place after that.
type discordPlanProgress struct {
	api       discordAPI
	channelID string
	replyTo   string
	logger    *slog.Logger

	mu        sync.Mutex
	messageID string
	last      string
}

func (p *discordPlanProgress) update(ctx context.Context, plan *agent.Plan) {
	if p == nil || p.api == nil {
		return
	}
	text := discordPlanProgressText(plan)
	if text == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if text == p.last {
		return
	}
	if p.messageID == "" {
		message, err := p.api.CreateMessage(ctx, p.channelID, discordapi.MessageCreate{
			Content: text, AllowedMentions: discordapi.NoMentions(), MessageReference: discordReplyReference(p.replyTo),
		})
		if err != nil {
			p.logger.Warn("discord_plan_progress_send_failed", "channel_id", p.channelID, "error", err.Error())
			return
		}
		p.messageID = message.ID
	} else if _, err := p.api.EditMessage(ctx, p.channelID, p.messageID, discordapi.MessageEdit{Content: &text, AllowedMentions: discordapi.NoMentions()}); err != nil {
		p.logger.Warn("discord_plan_progress_edit_failed", "channel_id", p.channelID, "message_id", p.messageID, "error", err.Error())
		return
	}
	p.last = text
}

// discordPlanProgressText renders the plan as a checklist: done, in progress, and still to do.
func discordPlanProgressText(plan *agent.Plan) string {
	if plan == nil || len(plan.Steps) == 0 {
		return ""
	}
	lines := []string{"**Plan**"}
	for _, step := range plan.Steps {
		text := strings.Join(strings.Fields(step.Step), " ")
		if text == "" {
			continue
		}
		marker := "⬜"
		switch step.Status {
		case agent.PlanStatusCompleted:
			marker = "✅"
		case agent.PlanStatusInProgress:
			marker = "▶️"
		}
		lines = append(lines, marker+" "+text)
	}
	if len(lines) == 1 {
		return ""
	}
	text := strings.Join(lines, "\n")
	if runes := []rune(text); len(runes) > discordapi.MaxMessageLength {
		text = string(runes[:discordapi.MaxMessageLength-1]) + "…"
	}
	return text
}

func buildDiscordPromptMessages(history []chathistory.ChatHistoryItem, job discordJob, model string, supportsImageParts *bool, logger *slog.Logger) ([]llm.Message, *llm.Message, error) {
	historyMessages := chathistory.RenderHistoryMessages(history)
	currentRaw := chathistory.RenderCurrentMessage(newDiscordInboundHistoryItem(job))
	if len(job.Images) > 0 {
		currentRaw = imageinput.AppendImageMetadataNotes(currentRaw, job.Images)
	} else {
		currentRaw = imageinput.AppendImagePathNotes(currentRaw, job.ImagePaths, job.FileCacheDir)
	}
	current, err := imageinput.BuildUserMessage(currentRaw, model, job.ImagePaths, imageinput.MessageOptions{
		MaxImages: discordLLMMaxImages, MaxBytes: discordImageMaxBytes,
		SupportsImageParts: supportsImageParts, Logger: logger, LogPrefix: "discord",
	})
	if err != nil {
		return nil, nil, err
	}
	return historyMessages, &current, nil
}

func todoResolveContextForDiscord(job discordJob) todo.AddResolveContext {
	mentions := make([]string, 0, len(job.MentionUsers))
	for _, userID := range job.MentionUsers {
		if userID = strings.TrimSpace(userID); userID != "" {
			mentions = append(mentions, "discord_user:"+userID)
		}
	}
	return todo.AddResolveContext{
		Channel:          "discord",
		ChatType:         job.ChatType,
		SpeakerUsername:  "discord_user:" + strings.TrimSpace(job.UserID),
		MentionUsernames: mentions,
		UserInputRaw:     job.Text,
	}
}

func contactsSendRuntimeContextForDiscord(job discordJob) builtin.ContactsSendRuntimeContext {
	ids := []string{"discord_user:" + strings.TrimSpace(job.UserID)}
	if !job.isGroup() {
		ids = append(ids, "discord:"+strings.TrimSpace(job.ChannelID))
	}
	return builtin.ContactsSendRuntimeContext{ForbiddenTargetIDs: ids}
}

func buildDiscordRegistry(base *tools.Registry, chatType string) *tools.Registry {
	registry := base.Clone()
	if chatType == discordbus.ChatTypeGroup {
		registry.Remove(toolsutil.BuiltinContactsSend)
	}
	return registry
}

func newDiscordInboundHistoryItem(job discordJob) chathistory.ChatHistoryItem {
	return chathistory.ChatHistoryItem{
		Channel:          chathistory.ChannelDiscord,
		Kind:             chathistory.KindInboundUser,
		ChatID:           "discord:" + strings.TrimSpace(job.ChannelID),
		ChatType:         job.ChatType,
		MessageID:        strings.TrimSpace(job.MessageID),
		ReplyToMessageID: strings.TrimSpace(job.ReplyToMessageID),
		SentAt:           job.SentAt.UTC(),
		Sender:           discordSenderFromJob(job),
		Text:             strings.TrimSpace(job.Text),
		Images:           append([]chathistory.ChatHistoryImage(nil), job.Images...),
	}
}

func newDiscordOutboundHistoryItem(job discordJob, botName, text string, sentAt time.Time) chathistory.ChatHistoryItem {
	return chathistory.ChatHistoryItem{
		Channel: chathistory.ChannelDiscord, Kind: chathistory.KindOutboundAgent,
		ChatID: "discord:" + strings.TrimSpace(job.ChannelID), ChatType: job.ChatType,
		ReplyToMessageID: strings.TrimSpace(job.MessageID), SentAt: sentAt.UTC(),
		Sender: discordBotSender(botName), Text: strings.TrimSpace(text),
	}
}

func discordBotSender(botName string) chathistory.ChatHistorySender {
	name := firstNonEmpty(botName, "discord-bot")
	return chathistory.ChatHistorySender{Username: name, Nickname: name, IsBot: true, DisplayRef: name}
}

func discordSenderFromJob(job discordJob) chathistory.ChatHistorySender {
	display := firstNonEmpty(job.DisplayName, job.Username, job.UserID)
	return chathistory.ChatHistorySender{
		UserID: strings.TrimSpace(job.UserID), Username: strings.TrimSpace(job.Username), Nickname: display,
		IsBot: job.FromIsAgent, DisplayRef: display,
	}
}

// discordTurnHistory is what one finished turn adds to the history: the message, a reaction, the
// step messages (sent before the reply, so they come first), then the reply.
func discordTurnHistory(job discordJob, botName string, result discordTaskResult, output string, now time.Time) []chathistory.ChatHistoryItem {
	items := []chathistory.ChatHistoryItem{newDiscordInboundHistoryItem(job)}
	if result.Reaction != nil {
		items = append(items, newDiscordOutboundHistoryItem(job, botName, "[reacted: "+result.Reaction.Emoji+"]", now))
	}
	var plan *agent.Plan
	if result.Context != nil && result.Context.Plan != nil {
		plan = result.Context.Plan
	} else if result.Final != nil {
		plan = result.Final.Plan
	}
	for _, note := range agent.PlanNotes(plan) {
		items = append(items, newDiscordOutboundHistoryItem(job, botName, note, now))
	}
	if output = strings.TrimSpace(output); output != "" {
		items = append(items, newDiscordOutboundHistoryItem(job, botName, output, now))
	}
	return items
}

func trimDiscordHistory(items []chathistory.ChatHistoryItem) []chathistory.ChatHistoryItem {
	if len(items) > discordHistoryLimit {
		items = items[len(items)-discordHistoryLimit:]
	}
	return append([]chathistory.ChatHistoryItem(nil), items...)
}

func capDiscordSkills(items []string) []string {
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, raw := range items {
		item := strings.TrimSpace(raw)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
		if len(out) == discordStickySkillsCap {
			break
		}
	}
	return out
}

// discordDeliveryReceipts lets a sender wait until the bus delivered its message.
type discordDeliveryReceipts struct {
	mu      sync.Mutex
	pending map[string]chan error
}

func newDiscordDeliveryReceipts() *discordDeliveryReceipts {
	return &discordDeliveryReceipts{pending: make(map[string]chan error)}
}

func (r *discordDeliveryReceipts) register(busMessageID string) (<-chan error, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.pending[busMessageID]; exists {
		return nil, fmt.Errorf("discord delivery receipt already registered: %s", busMessageID)
	}
	result := make(chan error, 1)
	r.pending[busMessageID] = result
	return result, nil
}

func (r *discordDeliveryReceipts) remove(busMessageID string) {
	r.mu.Lock()
	delete(r.pending, busMessageID)
	r.mu.Unlock()
}

func (r *discordDeliveryReceipts) complete(busMessageID string, err error) {
	r.mu.Lock()
	result := r.pending[busMessageID]
	delete(r.pending, busMessageID)
	r.mu.Unlock()
	if result != nil {
		result <- err
	}
}

func publishDiscordBusOutbound(ctx context.Context, bus *busruntime.Inproc, channelID, text, replyTo, correlationID string) error {
	message, err := newDiscordBusOutbound(channelID, text, replyTo, correlationID)
	if err != nil {
		return err
	}
	if ctx == nil || bus == nil {
		return fmt.Errorf("context and bus are required")
	}
	return bus.PublishValidated(ctx, message)
}

func publishDiscordBusOutboundAndWait(ctx context.Context, bus *busruntime.Inproc, receipts *discordDeliveryReceipts, channelID, text, replyTo, correlationID string) (string, error) {
	if ctx == nil || bus == nil || receipts == nil {
		return "", fmt.Errorf("context, bus, and delivery receipts are required")
	}
	message, err := newDiscordBusOutbound(channelID, text, replyTo, correlationID)
	if err != nil {
		return "", err
	}
	result, err := receipts.register(message.ID)
	if err != nil {
		return "", err
	}
	if err := bus.PublishValidated(ctx, message); err != nil {
		receipts.remove(message.ID)
		return "", err
	}
	select {
	case err := <-result:
		return message.ID, err
	case <-ctx.Done():
		receipts.remove(message.ID)
		return "", ctx.Err()
	}
}

func newDiscordBusOutbound(channelID, text, replyTo, correlationID string) (busruntime.BusMessage, error) {
	channelID = strings.TrimSpace(channelID)
	text = strings.TrimSpace(text)
	replyTo = strings.TrimSpace(replyTo)
	if channelID == "" || text == "" {
		return busruntime.BusMessage{}, fmt.Errorf("channel_id and text are required")
	}
	messageID := "discord:out:" + uuid.NewString()
	now := time.Now().UTC()
	session, err := uuid.NewV7()
	if err != nil {
		return busruntime.BusMessage{}, err
	}
	payload, err := busruntime.EncodeMessageEnvelope(busruntime.TopicChatMessage, busruntime.MessageEnvelope{
		MessageID: messageID, Text: text, SentAt: now.Format(time.RFC3339), SessionID: session.String(), ReplyTo: replyTo,
	})
	if err != nil {
		return busruntime.BusMessage{}, err
	}
	conversationKey, err := busruntime.BuildDiscordConversationKey(channelID)
	if err != nil {
		return busruntime.BusMessage{}, err
	}
	if strings.TrimSpace(correlationID) == "" {
		correlationID = messageID
	}
	return busruntime.BusMessage{
		ID: "bus_" + uuid.NewString(), Direction: busruntime.DirectionOutbound, Channel: busruntime.ChannelDiscord,
		Topic: busruntime.TopicChatMessage, ConversationKey: conversationKey, IdempotencyKey: idempotency.MessageEnvelopeKey(messageID),
		CorrelationID: correlationID, PayloadBase64: payload, CreatedAt: now,
		Extensions: busruntime.MessageExtensions{SessionID: session.String(), ReplyTo: replyTo, ChannelID: channelID},
	}, nil
}

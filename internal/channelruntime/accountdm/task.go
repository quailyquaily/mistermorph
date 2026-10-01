package accountdm

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/bus/adapters/accountdm"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/imageinput"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/todo"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools"
	dmtools "github.com/quailyquaily/mistermorph/tools/accountdm"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

// platformName is the channel's name as users know it.
func platformName(channel busruntime.Channel) string {
	if channel == busruntime.ChannelWeChat {
		return "WeChat"
	}
	return "WhatsApp"
}

const (
	stickySkillsCap = 16
	historyLimit    = 8
)

type dmJob struct {
	TaskID           string
	Channel          busruntime.Channel
	ConversationKey  string
	AccountID        string
	PeerID           string
	MessageID        string
	ReplyToMessageID string
	DisplayName      string
	Text             string
	ImagePaths       []string
	FileCacheDir     string
	WorkspaceDir     string
	Route            *llmutil.ResolvedRoute
	ResumeApprovalID string
	SentAt           time.Time
	Version          uint64
	Generation       *runtimecore.RuntimeGenerationLease
}

func (j dmJob) runtimeBundle() *runtimecore.ChannelRuntimeBundle {
	if j.Generation == nil {
		return nil
	}
	return j.Generation.Bundle()
}

func (j dmJob) releaseGeneration() {
	if j.Generation != nil {
		j.Generation.Release()
	}
}

func (j dmJob) approvalGuard() *guard.Guard {
	bundle := j.runtimeBundle()
	if bundle == nil || bundle.TaskRuntime == nil {
		return nil
	}
	return bundle.TaskRuntime.SharedGuard
}

// userRef is the contact reference of the job's peer: wechat_user:<id> or whatsapp_user:<id>.
func (j dmJob) userRef() string {
	return string(j.Channel) + "_user:" + j.PeerID
}

func taskConversation(j dmJob, accountID string) *taskdomain.TaskConversation {
	return runtimecore.BuildTaskConversation(j.ConversationKey, "private", j.PeerID, j.DisplayName, accountID, nil)
}

type taskEnv struct {
	channel      busruntime.Channel
	bus          *busruntime.Inproc
	receipts     *deliveryReceipts
	logger       *slog.Logger
	promptBlocks func(*agent.PromptSpec)
	sendFile     func(ctx context.Context, accountID, peerID string, file OutboundFile) error
	maxFileBytes int64
}

type taskResult struct {
	Final        *agent.Final
	Context      *agent.Context
	LoadedSkills []string
}

func runTask(ctx context.Context, rt *taskruntime.Runtime, env taskEnv, j dmJob, history []chathistory.ChatHistoryItem, stickySkills []string, steerSource agent.SteerSource) (taskResult, error) {
	if rt == nil {
		return taskResult{}, fmt.Errorf("%s task runtime is nil", env.channel)
	}
	ctx = llmstats.WithMetadata(ctx, j.TaskID, j.MessageID)
	ctx = topiccontext.WithScope(ctx, topiccontext.Scope{Runtime: string(env.channel), ConversationKey: j.ConversationKey, TopicID: j.PeerID})
	ctx = pathroots.WithWorkspaceDir(ctx, j.WorkspaceDir)
	ctx = builtin.WithContactsSendRuntimeContext(ctx, builtin.ContactsSendRuntimeContext{ForbiddenTargetIDs: []string{j.userRef()}})
	task := strings.TrimSpace(j.Text)
	routePurpose, reasoningEffort := "", ""
	if thinkTask, ok := chatcommands.ExtractThinkTask(task); ok {
		task = strings.TrimSpace(thinkTask)
		j.Text = task
		routePurpose = llmutil.RoutePurposeThink
		reasoningEffort = llmutil.ReasoningEffortXHigh
	}
	if task == "" {
		return taskResult{}, fmt.Errorf("empty %s task", env.channel)
	}
	var mainRoute llmutil.ResolvedRoute
	if j.Route != nil {
		mainRoute = *j.Route
	} else {
		resolved, err := rt.ResolveRouteForRun(ctx, routePurpose)
		if err != nil {
			return taskResult{}, err
		}
		mainRoute = resolved
	}
	if reasoningEffort != "" {
		mainRoute = llmutil.ResolvedRouteWithReasoningEffort(mainRoute, reasoningEffort)
	}
	checkpoint, err := rt.PrepareContextHistory(ctx, j.ConversationKey, history, inboundHistoryItem(j))
	if err != nil {
		return taskResult{}, err
	}
	currentRaw := imageinput.AppendImagePathNotes(chathistory.RenderCurrentMessage(inboundHistoryItem(j)), j.ImagePaths, j.FileCacheDir)
	current, err := imageinput.BuildUserMessage(currentRaw, strings.TrimSpace(mainRoute.ClientConfig.Model), j.ImagePaths, imageinput.MessageOptions{
		MaxImages: llmMaxImages, MaxBytes: llmImageMaxBytes,
		SupportsImageParts: mainRoute.Values.SupportsImageParts, Logger: env.logger, LogPrefix: string(env.channel),
	})
	if err != nil {
		return taskResult{}, err
	}
	// Each finished plan step's note goes out as a message of its own, before the answer. There is no
	// plan progress message: neither channel can edit a sent message.
	planStepUpdate := func(runCtx *agent.Context, update agent.PlanStepUpdate) {
		note := strings.TrimSpace(update.CompletedNote)
		if note == "" {
			return
		}
		correlation := fmt.Sprintf("%s:step:%s:%d", env.channel, j.TaskID, update.CompletedIndex)
		if err := publishAndWait(ctx, env.bus, env.receipts, env.channel, j.AccountID, j.PeerID, note, "", correlation); err != nil {
			env.logger.Warn("plan_step_send_failed", "channel", env.channel, "task_id", j.TaskID, "error", err.Error())
		}
	}
	meta := taskruntime.ApplyObservationMeta(map[string]any{
		"trigger":                         string(env.channel),
		string(env.channel) + "_peer_id":  j.PeerID,
		string(env.channel) + "_message":  j.MessageID,
		string(env.channel) + "_conv_key": j.ConversationKey,
	}, taskruntime.ObservationMetaIDs{TaskID: j.TaskID, TraceID: j.TaskID, TopicID: j.PeerID, OriginEventID: j.MessageID})
	registry := rt.BaseRegistry.Clone()
	if env.sendFile != nil && strings.TrimSpace(j.FileCacheDir) != "" {
		send := func(sendCtx context.Context, path, filename, message string) error {
			return env.sendFile(sendCtx, j.AccountID, j.PeerID, outboundFile(path, filename, message))
		}
		if err := registry.Replace(dmtools.NewSendFileTool(string(env.channel), platformName(env.channel), send, j.FileCacheDir, env.maxFileBytes)); err != nil {
			return taskResult{}, err
		}
	}
	request := taskruntime.RunRequest{
		Task:                    task,
		Model:                   strings.TrimSpace(mainRoute.ClientConfig.Model),
		Route:                   &mainRoute,
		RoutePurpose:            routePurpose,
		ReasoningEffortOverride: reasoningEffort,
		Scene:                   string(env.channel) + ".loop",
		History:                 chathistory.RenderHistoryMessages(checkpoint.History),
		CurrentMessage:          &current,
		Meta:                    meta,
		StickySkills:            stickySkills,
		Registry:                registry,
		PromptAugment: func(spec *agent.PromptSpec, reg *tools.Registry) {
			if block := workspace.PromptBlock(j.WorkspaceDir); strings.TrimSpace(block.Content) != "" {
				spec.Blocks = append([]agent.PromptBlock{block}, spec.Blocks...)
			}
			toolsutil.SetTodoUpdateToolAddContext(reg, todo.AddResolveContext{
				Channel: string(env.channel), ChatType: "private", SpeakerUsername: j.userRef(), UserInputRaw: j.Text,
			})
			if env.promptBlocks != nil {
				env.promptBlocks(spec)
			}
		},
		PlanStepUpdate:         planStepUpdate,
		SteerSource:            steerSource,
		ImageToolScope:         j.ConversationKey,
		ImageToolRetention:     toolsutil.ImageToolRetentionCountdown,
		ContextCheckpointStore: checkpoint.Store,
		HistoryBoundaries:      checkpoint.HistoryBoundaries,
		CurrentMessageBoundary: checkpoint.CurrentMessageBoundary,
	}
	var result taskruntime.RunResult
	if approvalID := strings.TrimSpace(j.ResumeApprovalID); approvalID != "" {
		result, err = rt.Resume(ctx, approvalID, request)
	} else {
		result, err = rt.Run(ctx, request)
	}
	return taskResult{Final: result.Final, Context: result.Context, LoadedSkills: result.LoadedSkills}, err
}

func inboundHistoryItem(j dmJob) chathistory.ChatHistoryItem {
	display := firstNonEmpty(j.DisplayName, j.PeerID)
	return chathistory.ChatHistoryItem{
		Channel:          string(j.Channel),
		Kind:             chathistory.KindInboundUser,
		ChatID:           string(j.Channel) + ":" + j.PeerID,
		ChatType:         "private",
		MessageID:        j.MessageID,
		ReplyToMessageID: j.ReplyToMessageID,
		SentAt:           j.SentAt.UTC(),
		Sender:           chathistory.ChatHistorySender{UserID: j.PeerID, Nickname: display, DisplayRef: display},
		Text:             strings.TrimSpace(j.Text),
	}
}

func outboundHistoryItem(j dmJob, text string, sentAt time.Time) chathistory.ChatHistoryItem {
	return chathistory.ChatHistoryItem{
		Channel: string(j.Channel), Kind: chathistory.KindOutboundAgent,
		ChatID: string(j.Channel) + ":" + j.PeerID, ChatType: "private",
		ReplyToMessageID: j.MessageID, SentAt: sentAt.UTC(),
		Sender: chathistory.ChatHistorySender{Username: "agent", Nickname: "agent", IsBot: true, DisplayRef: "agent"},
		Text:   strings.TrimSpace(text),
	}
}

// turnHistory is what a finished turn adds: the message, the step messages (sent first), the reply.
func turnHistory(j dmJob, result taskResult, output string, now time.Time) []chathistory.ChatHistoryItem {
	items := []chathistory.ChatHistoryItem{inboundHistoryItem(j)}
	var plan *agent.Plan
	if result.Context != nil && result.Context.Plan != nil {
		plan = result.Context.Plan
	} else if result.Final != nil {
		plan = result.Final.Plan
	}
	for _, note := range agent.PlanNotes(plan) {
		items = append(items, outboundHistoryItem(j, note, now))
	}
	if output = strings.TrimSpace(output); output != "" {
		items = append(items, outboundHistoryItem(j, output, now))
	}
	return items
}

func trimHistory(items []chathistory.ChatHistoryItem) []chathistory.ChatHistoryItem {
	if len(items) > historyLimit {
		items = items[len(items)-historyLimit:]
	}
	return append([]chathistory.ChatHistoryItem(nil), items...)
}

func capSkills(items []string) []string {
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, raw := range items {
		item := strings.TrimSpace(raw)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
		if len(out) == stickySkillsCap {
			break
		}
	}
	return out
}

// deliveryReceipts lets a sender wait until the bus delivered its message.
type deliveryReceipts struct {
	mu      sync.Mutex
	pending map[string]chan error
}

func newDeliveryReceipts() *deliveryReceipts {
	return &deliveryReceipts{pending: make(map[string]chan error)}
}

func (r *deliveryReceipts) register(id string) (<-chan error, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.pending[id]; exists {
		return nil, fmt.Errorf("delivery receipt already registered: %s", id)
	}
	result := make(chan error, 1)
	r.pending[id] = result
	return result, nil
}

func (r *deliveryReceipts) remove(id string) {
	r.mu.Lock()
	delete(r.pending, id)
	r.mu.Unlock()
}

func (r *deliveryReceipts) complete(id string, err error) {
	r.mu.Lock()
	result := r.pending[id]
	delete(r.pending, id)
	r.mu.Unlock()
	if result != nil {
		result <- err
	}
}

func publish(ctx context.Context, bus *busruntime.Inproc, channel busruntime.Channel, accountID, peerID, text, replyTo, correlation string) error {
	message, err := accountdm.NewOutbound(channel, accountID, peerID, text, replyTo, string(channel)+":"+correlation)
	if err != nil {
		return err
	}
	return bus.PublishValidated(ctx, message)
}

func publishAndWait(ctx context.Context, bus *busruntime.Inproc, receipts *deliveryReceipts, channel busruntime.Channel, accountID, peerID, text, replyTo, correlation string) error {
	message, err := accountdm.NewOutbound(channel, accountID, peerID, text, replyTo, correlation)
	if err != nil {
		return err
	}
	result, err := receipts.register(message.ID)
	if err != nil {
		return err
	}
	if err := bus.PublishValidated(ctx, message); err != nil {
		receipts.remove(message.ID)
		return err
	}
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		receipts.remove(message.ID)
		return ctx.Err()
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

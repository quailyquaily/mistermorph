package discord

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/guard"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
)

const discordRuntimeClosedApprovalError = "Discord runtime closed while approval was pending. Task failed."

type discordApprovalMessage struct {
	ChannelID string
	MessageID string
	Text      string
}

type discordApprovalManager struct {
	api         discordAPI
	bus         *busruntime.Inproc
	store       daemonruntime.TaskView
	workersCtx  context.Context
	logger      *slog.Logger
	runner      *runtimecore.ConversationRunner[string, discordJob]
	pending     *runtimecore.PendingApprovalRegistry[discordJob]
	generations *runtimecore.RuntimeGenerationManager

	messagesMu sync.Mutex
	messages   map[string]discordApprovalMessage
}

func newDiscordApprovalManager(api discordAPI, bus *busruntime.Inproc, store daemonruntime.TaskView, generations *runtimecore.RuntimeGenerationManager, workersCtx context.Context, logger *slog.Logger) *discordApprovalManager {
	if logger == nil {
		logger = slog.Default()
	}
	m := &discordApprovalManager{api: api, messages: make(map[string]discordApprovalMessage), bus: bus, store: store, generations: generations, workersCtx: workersCtx, logger: logger}
	m.pending = runtimecore.NewPendingApprovalRegistry(func(claim runtimecore.PendingApprovalClaim[discordJob]) {
		job := claim.Job
		retainGeneration := false
		defer func() {
			if !retainGeneration {
				job.releaseGeneration()
			}
		}()
		err := runtimecore.ExpirePendingApproval(context.Background(), job.approvalGuard(), store, claim.ID, job.TaskID, "discord:expiry")
		if errors.Is(err, runtimecore.ErrApprovalCommitIndeterminate) || errors.Is(err, runtimecore.ErrApprovalTaskFinalizationFailed) {
			if restoreErr := m.pending.RestoreClaim(claim, time.Now().Add(runtimecore.PendingApprovalRetryDelay)); restoreErr == nil {
				retainGeneration = true
				logger.Warn("discord_approval_expiry_retry", "approval_request_id", claim.ID, "task_id", job.TaskID, "error", err.Error())
				return
			}
		}
		if err != nil && !errors.Is(err, guard.ErrApprovalNotPending) {
			logger.Error("discord_approval_expiry_error", "approval_request_id", claim.ID, "task_id", job.TaskID, "error", err.Error())
		}
		if err == nil {
			m.settleMessage(context.Background(), claim.ID, false, "", errors.New("Approval expired"))
		}
	})
	return m
}

func (m *discordApprovalManager) listApprovals(ctx context.Context, req daemonruntime.ApprovalListRequest) (daemonruntime.ApprovalListResponse, error) {
	lease, bundle, err := m.captureRuntimeGeneration()
	if err != nil {
		return daemonruntime.ApprovalListResponse{}, err
	}
	defer lease.Release()
	return runtimecore.ListPendingApprovals(ctx, m.store, bundle.TaskRuntime.SharedGuard, req, "discord")
}

func (m *discordApprovalManager) getApproval(ctx context.Context, approvalID string) (daemonruntime.ApprovalInfo, bool, error) {
	lease, bundle, err := m.captureRuntimeGeneration()
	if err != nil {
		return daemonruntime.ApprovalInfo{}, false, err
	}
	defer lease.Release()
	return runtimecore.GetApprovalInfo(ctx, bundle.TaskRuntime.SharedGuard, approvalID, "discord")
}

func (m *discordApprovalManager) captureRuntimeGeneration() (*runtimecore.RuntimeGenerationLease, *runtimecore.ChannelRuntimeBundle, error) {
	if m == nil || m.generations == nil {
		return nil, nil, fmt.Errorf("discord runtime generation is unavailable")
	}
	lease, err := m.generations.Capture()
	if err != nil {
		return nil, nil, err
	}
	bundle := lease.Bundle()
	if bundle == nil || bundle.TaskRuntime == nil {
		lease.Release()
		return nil, nil, fmt.Errorf("discord runtime generation is unavailable")
	}
	return lease, bundle, nil
}

func (m *discordApprovalManager) approve(ctx context.Context, req daemonruntime.ApprovalDecisionRequest) (daemonruntime.ApprovalDecisionResponse, error) {
	taskID, resumed, err := m.apply(ctx, req.ApprovalRequestID, true, strings.TrimSpace(req.Actor), nil)
	if err != nil {
		if taskID != "" {
			return daemonruntime.ApprovalDecisionResponse{
				ApprovalRequestID: strings.TrimSpace(req.ApprovalRequestID), TaskID: taskID,
				Status: string(guard.ApprovalApproved), Error: strings.TrimSpace(err.Error()),
			}, nil
		}
		return daemonruntime.ApprovalDecisionResponse{}, err
	}
	return daemonruntime.ApprovalDecisionResponse{
		ApprovalRequestID: strings.TrimSpace(req.ApprovalRequestID), TaskID: taskID,
		Status: string(guard.ApprovalApproved), Resumed: resumed,
	}, nil
}

func (m *discordApprovalManager) deny(ctx context.Context, req daemonruntime.ApprovalDecisionRequest) (daemonruntime.ApprovalDecisionResponse, error) {
	taskID, resumed, err := m.apply(ctx, req.ApprovalRequestID, false, strings.TrimSpace(req.Actor), nil)
	if err != nil {
		return daemonruntime.ApprovalDecisionResponse{}, err
	}
	return daemonruntime.ApprovalDecisionResponse{
		ApprovalRequestID: strings.TrimSpace(req.ApprovalRequestID), TaskID: taskID,
		Status: string(guard.ApprovalDenied), Resumed: resumed,
	}, nil
}

func parseDiscordApprovalCommand(text string) (approvalID string, approved bool, ok bool) {
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) != 2 {
		return "", false, false
	}
	switch strings.ToLower(fields[0]) {
	case "/approve":
		return fields[1], true, true
	case "/deny":
		return fields[1], false, true
	default:
		return "", false, false
	}
}

// discordApprovalRequestText is the approval message: what is asked, why, and the fallback commands.
// In servers a command needs a bot mention, which the hint says.
func discordApprovalRequestText(rec guard.ApprovalRecord, isGroup bool) string {
	parts := []string{"**Approval required**"}
	if toolName := strings.TrimSpace(rec.ToolName); toolName != "" {
		parts = append(parts, "Tool: `"+discordInlineCode(toolName)+"`")
	}
	if len(rec.Reasons) > 0 {
		parts = append(parts, "Reasons:")
		for _, reason := range rec.Reasons {
			if reason = strings.TrimSpace(reason); reason != "" {
				parts = append(parts, "- "+reason)
			}
		}
	}
	if summary := strings.TrimSpace(rec.ActionSummaryRedacted); summary != "" {
		parts = append(parts, "Action: "+summary)
	}
	params := runtimecore.ApprovalToolParams(rec)
	if len(params) > 0 {
		parts = append(parts, "Parameters:")
		keys := make([]string, 0, len(params))
		for key := range params {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			parts = append(parts, fmt.Sprintf("- %s: `%s`", key, discordInlineCode(fmt.Sprint(params[key]))))
		}
	}
	if id := strings.TrimSpace(rec.ID); id != "" {
		hint := fmt.Sprintf("Or reply `/approve %s` or `/deny %s`", id, id)
		if isGroup {
			hint += ", mentioning me"
		}
		parts = append(parts, "", hint+".")
	}
	return truncateDiscordText(strings.Join(parts, "\n"), discordapi.MaxMessageLength)
}

// discordApprovalButtons are the Approve and Deny buttons; their custom IDs carry the approval ID.
func discordApprovalButtons(approvalID string) []discordapi.Component {
	return []discordapi.Component{{
		Type: discordapi.ComponentTypeActionRow,
		Components: []discordapi.Component{
			{Type: discordapi.ComponentTypeButton, Style: discordapi.ButtonStyleSuccess, Label: "Approve", CustomID: discordApprovalCustomIDPrefix + "approve:" + approvalID},
			{Type: discordapi.ComponentTypeButton, Style: discordapi.ButtonStyleDanger, Label: "Deny", CustomID: discordApprovalCustomIDPrefix + "deny:" + approvalID},
		},
	}}
}

const discordApprovalCustomIDPrefix = "morph:"

// parseDiscordApprovalCustomID reads a button's custom ID: morph:approve:<id> or morph:deny:<id>.
func parseDiscordApprovalCustomID(customID string) (approvalID string, approved bool, ok bool) {
	rest, found := strings.CutPrefix(strings.TrimSpace(customID), discordApprovalCustomIDPrefix)
	if !found {
		return "", false, false
	}
	decision, id, found := strings.Cut(rest, ":")
	id = strings.TrimSpace(id)
	if !found || id == "" {
		return "", false, false
	}
	switch decision {
	case "approve":
		return id, true, true
	case "deny":
		return id, false, true
	default:
		return "", false, false
	}
}

// discordApprovalOutcomeText is the approval message once decided: the request, then who decided.
func discordApprovalOutcomeText(request string, approved bool, userID string, err error) string {
	line := "✅ Approved"
	if !approved {
		line = "❌ Denied"
	}
	if userID = strings.TrimSpace(userID); userID != "" {
		line += " by <@" + userID + ">"
	}
	if err != nil {
		line = "⚠️ " + strings.TrimSpace(err.Error())
	}
	request = strings.TrimSpace(request)
	return truncateDiscordText(request, discordapi.MaxMessageLength-len(line)-2) + "\n\n" + line
}

func discordInlineCode(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	value = strings.ReplaceAll(value, "`", "'")
	return truncateDiscordText(value, 300)
}

func truncateDiscordText(text string, max int) string {
	runes := []rune(text)
	if max <= 0 || len(runes) <= max {
		return text
	}
	return string(runes[:max-1]) + "…"
}

func discordApprovalResultText(approved bool) string {
	if approved {
		return "Approved. Resuming task."
	}
	return "Approval denied. Task canceled."
}

func (m *discordApprovalManager) register(approvalID string, job discordJob) error {
	if m == nil || m.pending == nil {
		return fmt.Errorf("approvals are unavailable")
	}
	g := job.approvalGuard()
	if g == nil {
		return fmt.Errorf("approvals are unavailable")
	}
	rec, found, err := g.GetApproval(context.Background(), strings.TrimSpace(approvalID))
	if err != nil {
		return err
	}
	if !found {
		return guard.ErrApprovalNotFound
	}
	displaced, replaced, err := m.pending.Register(rec.ID, job, rec.ExpiresAt)
	if replaced {
		displaced.releaseGeneration()
	}
	return err
}

// notify sends the approval message with its buttons, and remembers it so a decision made by command
// can take the buttons away too.
func (m *discordApprovalManager) notify(ctx context.Context, approvalID string, job discordJob) error {
	g := job.approvalGuard()
	if g == nil {
		return fmt.Errorf("approvals are unavailable")
	}
	rec, found, err := g.GetApproval(ctx, strings.TrimSpace(approvalID))
	if err != nil {
		return err
	}
	if !found {
		return guard.ErrApprovalNotFound
	}
	if m.api == nil {
		return fmt.Errorf("discord api is unavailable")
	}
	text := discordApprovalRequestText(rec, job.isGroup())
	message, err := m.api.CreateMessage(ctx, job.ChannelID, discordapi.MessageCreate{
		Content: text, AllowedMentions: discordapi.NoMentions(), MessageReference: discordReplyReference(job.replyTarget()),
		Components: discordApprovalButtons(rec.ID),
	})
	if err != nil {
		return err
	}
	m.messagesMu.Lock()
	m.messages[rec.ID] = discordApprovalMessage{ChannelID: job.ChannelID, MessageID: message.ID, Text: text}
	m.messagesMu.Unlock()
	return nil
}

// takeMessage returns the approval message and forgets it.
func (m *discordApprovalManager) takeMessage(approvalID string) (discordApprovalMessage, bool) {
	m.messagesMu.Lock()
	defer m.messagesMu.Unlock()
	message, found := m.messages[approvalID]
	delete(m.messages, approvalID)
	return message, found
}

// settleMessage replaces the approval message's buttons with the outcome.
func (m *discordApprovalManager) settleMessage(ctx context.Context, approvalID string, approved bool, userID string, decisionErr error) {
	message, found := m.takeMessage(approvalID)
	if !found || m.api == nil {
		return
	}
	text := discordApprovalOutcomeText(message.Text, approved, userID, decisionErr)
	components := []discordapi.Component{}
	if _, err := m.api.EditMessage(ctx, message.ChannelID, message.MessageID, discordapi.MessageEdit{
		Content: &text, AllowedMentions: discordapi.NoMentions(), Components: &components,
	}); err != nil {
		m.logger.Warn("discord_approval_message_edit_failed", "approval_request_id", approvalID, "channel_id", message.ChannelID, "error", err.Error())
	}
}

func (m *discordApprovalManager) apply(ctx context.Context, approvalID string, approved bool, actor string, authorize func(discordJob) bool) (string, bool, error) {
	if m == nil || m.pending == nil {
		return "", false, fmt.Errorf("approvals are unavailable")
	}
	approvalID = strings.TrimSpace(approvalID)
	if approvalID == "" {
		return "", false, daemonruntime.BadRequest("approval_request_id is required")
	}
	claim, state, err := m.pending.Claim(approvalID)
	if err != nil {
		return "", false, err
	}
	if state == runtimecore.PendingApprovalClaimInFlight {
		return claim.Job.TaskID, false, runtimecore.ErrPendingApprovalClaimInFlight
	}
	if state == runtimecore.PendingApprovalClaimMissing {
		return "", false, daemonruntime.BadRequest("approval is not pending")
	}
	job := claim.Job
	retainGeneration := false
	defer func() {
		if !retainGeneration {
			job.releaseGeneration()
		}
	}()
	defer m.pending.CompleteClaim(claim)

	g := job.approvalGuard()
	if g == nil {
		return job.TaskID, false, fmt.Errorf("approvals are unavailable")
	}
	rec, found, err := g.GetApproval(ctx, approvalID)
	if err != nil || !found {
		if err == nil {
			err = guard.ErrApprovalNotFound
		}
		return job.TaskID, false, err
	}
	if authorize != nil && !authorize(job) {
		if restoreErr := m.pending.RestoreClaim(claim, rec.ExpiresAt); restoreErr != nil {
			return job.TaskID, false, errors.Join(daemonruntime.BadRequest("approval sender is not authorized"), restoreErr)
		}
		retainGeneration = true
		return job.TaskID, false, daemonruntime.BadRequest("approval sender is not authorized")
	}
	if rec.Status != guard.ApprovalPending {
		return job.TaskID, false, daemonruntime.BadRequest("approval is not pending")
	}
	if !rec.ExpiresAt.IsZero() && time.Now().UTC().After(rec.ExpiresAt) {
		_ = runtimecore.ExpirePendingApproval(ctx, g, m.store, approvalID, job.TaskID, "discord:expiry")
		return job.TaskID, false, daemonruntime.BadRequest("approval is expired")
	}
	status := guard.ApprovalDenied
	if approved {
		status = guard.ApprovalApproved
	}
	commit, pendingRec, resolveErr := runtimecore.ResolveApprovalCommit(ctx, g, approvalID, status, strings.TrimSpace(actor), "")
	if resolveErr != nil {
		if commit == runtimecore.ApprovalCommitPending {
			if restoreErr := m.pending.RestoreClaim(claim, pendingRec.ExpiresAt); restoreErr == nil {
				retainGeneration = true
				return job.TaskID, false, resolveErr
			}
		}
		_, _ = runtimecore.FailPendingApprovalTask(m.store, job.TaskID, approvalID, "approval resume failed: "+resolveErr.Error())
		return job.TaskID, false, resolveErr
	}
	if !approved {
		finishedAt := time.Now().UTC()
		err := m.store.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
			info.Status = daemonruntime.TaskCanceled
			info.Error = discordApprovalResultText(false)
			info.FinishedAt = &finishedAt
			runtimecore.ClearTaskPendingApprovalFields(info)
			info.ApprovalRequestID = approvalID
		})
		return job.TaskID, false, err
	}
	if m.runner == nil {
		_, _ = runtimecore.FailPendingApprovalTask(m.store, job.TaskID, approvalID, "approval resume failed: runner unavailable")
		return job.TaskID, false, fmt.Errorf("approval runner is unavailable")
	}
	job.ResumeApprovalID = approvalID
	resumedAt := time.Now().UTC()
	if err := m.store.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
		info.Status = daemonruntime.TaskQueued
		info.Error = ""
		info.ResumedAt = &resumedAt
		runtimecore.ClearTaskPendingApprovalFields(info)
	}); err != nil {
		return job.TaskID, false, err
	}
	if err := m.runner.Enqueue(m.workersCtx, job.ConversationKey, func(version uint64) discordJob {
		job.Version = version
		return job
	}); err != nil {
		_, _ = runtimecore.FailPendingApprovalTask(m.store, job.TaskID, approvalID, "approval resume failed: "+err.Error())
		return job.TaskID, false, err
	}
	retainGeneration = true
	return job.TaskID, true, nil
}

func (m *discordApprovalManager) close() {
	if m == nil || m.pending == nil {
		return
	}
	for _, handle := range m.pending.Close() {
		_, _ = runtimecore.FailPendingApprovalTask(m.store, handle.Job.TaskID, handle.ID, discordRuntimeClosedApprovalError)
		handle.Job.releaseGeneration()
	}
}

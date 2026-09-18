package chatcmd

import (
	"net/url"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

type sharedApproval struct {
	gen       uint64
	topic, id string
	info      daemonruntime.ApprovalInfo
	err       error
}
type sharedApprovalDecision struct {
	gen       uint64
	topic, id string
	response  daemonruntime.ApprovalDecisionResponse
	err       error
}

func (m *chatModel) loadSharedApproval() tea.Cmd {
	if m.listing || m.deleted || m.approvalLoading {
		return nil
	}
	id := ""
	for _, t := range m.tasks {
		if t.TopicID == m.id && t.Status == taskdomain.TaskPending && t.ApprovalRequestID != "" && !m.resolvedApprovals[t.ApprovalRequestID] && (id == "" || t.ApprovalRequestID < id) {
			id = t.ApprovalRequestID
		}
	}
	if id == "" {
		m.approval = nil
		m.approvalParams = nil
		return nil
	}
	m.approvalLoading = true
	ctx, c, g, topic := m.viewCtx, m.client, m.gen, m.id
	return func() tea.Msg {
		out := sharedApproval{gen: g, topic: topic, id: id}
		out.err = c.request(ctx, "GET", "/approvals/"+url.PathEscape(id), nil, &out.info)
		return out
	}
}

func (m *chatModel) decideSharedApproval(approve bool) tea.Cmd {
	if m.approval == nil {
		return m.enqueueTranscript(formatChatCommandOutput("/approve", "No approval is pending.", m.commandRegistry))
	}
	if m.approvalResolving {
		return nil
	}
	m.approvalResolving = true
	action := "deny"
	if approve {
		action = "approve"
	}
	ctx, c, g, topic, id := m.ctx, m.client, m.gen, m.id, m.approval.ID
	return func() tea.Msg {
		out := sharedApprovalDecision{gen: g, topic: topic, id: id}
		out.err = c.request(ctx, "POST", "/approvals/"+url.PathEscape(id)+"/"+action, daemonruntime.ApprovalDecisionRequest{Actor: "chat:user"}, &out.response)
		return out
	}
}

func (m *chatModel) applySharedApproval(r sharedApproval) {
	if r.gen != m.gen || r.topic != m.id {
		return
	}
	m.approvalLoading = false
	if m.resolvedApprovals[r.id] {
		return
	}
	if r.err != nil {
		m.notice = r.err.Error()
		return
	}
	if r.info.ApprovalRequestID != r.id || r.info.TopicID != m.id || r.info.Status != "pending" {
		if m.approval != nil && m.approval.ID == r.id {
			m.approval = nil
			m.approvalParams = nil
		}
		return
	}
	task, ok := m.tasks[r.info.TaskID]
	if !ok || task.ApprovalRequestID != r.id || task.Status != taskdomain.TaskPending {
		return
	}
	if m.approval != nil && m.approval.ID == r.id {
		return
	}
	m.approval = &guard.ApprovalRecord{ID: r.id, RunID: r.info.RunID, Status: guard.ApprovalPending, ToolName: r.info.ToolName, ActionSummaryRedacted: r.info.ActionSummaryRedacted, Reasons: r.info.Reasons, CreatedAt: r.info.CreatedAt, ExpiresAt: r.info.ExpiresAt}
	m.approvalParams = r.info.ToolParams
	m.approvalResolving = false
	m.approvalScroll = 0
	m.clearThinking()
}

func (m *chatModel) applySharedApprovalDecision(r sharedApprovalDecision) tea.Cmd {
	if r.err == nil {
		if m.resolvedApprovals == nil {
			m.resolvedApprovals = map[string]bool{}
		}
		m.resolvedApprovals[r.id] = true
	}
	if r.gen != m.gen || r.topic != m.id {
		return nil
	}
	if m.approval != nil && m.approval.ID != r.id {
		return nil
	}
	m.approvalResolving = false
	if r.err != nil {
		return m.enqueueTranscript(chatErrorStyle.Render(r.err.Error()))
	}
	m.approval = nil
	m.approvalParams = nil
	text := "Approval " + r.response.Status
	if r.response.Error != "" {
		text += " — " + strings.TrimSpace(r.response.Error)
	}
	return tea.Batch(m.enqueueTranscript(formatChatCommandOutput("/approve", text, m.commandRegistry)), m.load(m.id, true))
}

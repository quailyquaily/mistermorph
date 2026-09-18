package chatcmd

import (
	"net/url"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

// HTTP task state drives the common activity indicator, even without a stream.
func (m *chatModel) syncSharedActivity() tea.Cmd {
	if m.listing || m.deleted || m.approval != nil {
		m.clearThinking()
		return nil
	}
	var active *taskdomain.TaskInfo
	for _, task := range m.tasks {
		if task.TopicID != "" && task.TopicID != m.id {
			continue
		}
		if task.Status != taskdomain.TaskQueued && task.Status != taskdomain.TaskRunning {
			continue
		}
		if active == nil || (task.Status == taskdomain.TaskRunning && active.Status != taskdomain.TaskRunning) || (task.Status == active.Status && task.ID < active.ID) {
			copy := task
			active = &copy
		}
	}
	pending := m.draft().pending
	if active == nil && !pending && !(m.loading && m.thinking) {
		m.clearThinking()
		return nil
	}
	wasThinking := m.thinking
	m.thinking = true
	m.thinkingMessage, m.thinkingTool = "waiting for model", false
	if pending {
		m.thinkingMessage = "sending"
	}
	if active != nil {
		if active.Status == taskdomain.TaskQueued {
			m.thinkingMessage = "queued"
		}
		if active.StartedAt != nil {
			m.runStartedAt = *active.StartedAt
		} else if !active.CreatedAt.IsZero() {
			m.runStartedAt = active.CreatedAt
		}
		if stream := m.streams[active.ID]; stream != nil && stream.activity != "" {
			m.thinkingMessage, m.thinkingTool = stream.activity, true
		}
		if activity := m.traceActivity[active.ID]; activity != "" {
			m.thinkingMessage = activity
			m.thinkingTool = false
		}
	}
	if m.runStartedAt.IsZero() {
		m.runStartedAt = time.Now()
	}
	if !wasThinking {
		m.activityNow = time.Now()
		return activityTick()
	}
	return nil
}

type sharedMetadata struct {
	gen      uint64
	id       string
	metadata daemonruntime.TopicMetadata
	err      error
}

func (m *chatModel) loadSharedMetadata() tea.Cmd {
	if m.metadataLoading || m.id == "" {
		return nil
	}
	m.metadataLoading = true
	ctx, client, gen, id := m.viewCtx, m.client, m.gen, m.id
	return func() tea.Msg {
		result := sharedMetadata{gen: gen, id: id}
		result.err = client.request(ctx, "GET", "/topic/"+url.PathEscape(id)+"/metadata", nil, &result.metadata)
		return result
	}
}

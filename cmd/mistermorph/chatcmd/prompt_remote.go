package chatcmd

import (
	"errors"
	"net/url"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// chatTaskTrigger marks a task sent from chat, so the Console runtime puts the task's questions
// and approval cards to chat.
func chatTaskTrigger() *daemonruntime.TaskTrigger {
	return &daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: "cli/chat"}
}

// remoteQuestion is a question in a Console stream frame (ask_user).
type remoteQuestion struct {
	ID      string                           `json:"id"`
	Text    string                           `json:"text"`
	Options []taskruntime.UserQuestionOption `json:"options,omitempty"`
	Status  string                           `json:"status"`
	Answer  string                           `json:"answer,omitempty"`
	Option  *int                             `json:"option,omitempty"`
}

// remoteElevation is an approval card in a Console stream frame.
type remoteElevation struct {
	ID       string `json:"id"`
	Command  string `json:"command"`
	Cwd      string `json:"cwd,omitempty"`
	Host     string `json:"host,omitempty"`
	Deadline int64  `json:"deadline"`
	Attempt  int    `json:"attempt,omitempty"`
	Status   string `json:"status"`
	Insecure string `json:"insecure,omitempty"`
}

// remotePromptResult is the runtime's reply to an answer sent from a card.
type remotePromptResult struct {
	key      string
	accepted bool
	decline  bool
	text     string
	err      error
}

func remoteQuestionKey(taskID, id string) string  { return "question:" + taskID + "/" + id }
func remoteElevationKey(taskID, id string) string { return "elevation:" + taskID + "/" + id }

// syncRemotePrompts opens the cards a task's frame shows open, and closes the ones it shows ended.
// A frame carries every question and approval of the task so far.
func (m *chatModel) syncRemotePrompts(taskID string, f remoteStreamFrame) tea.Cmd {
	var cmds []tea.Cmd
	for _, q := range f.Questions {
		if strings.TrimSpace(q.ID) == "" {
			continue
		}
		key := remoteQuestionKey(taskID, q.ID)
		if q.Status == "open" {
			if m.findPrompt(key) == nil && !m.closedPrompts[key] {
				p := newQuestionPrompt(key, taskruntime.UserQuestion{ID: q.ID, Text: q.Text, Options: q.Options}, time.Time{})
				p.taskID = taskID
				p.respond = remoteQuestionRespond
				cmds = append(cmds, m.openPrompt(p))
			}
			continue
		}
		outcome := "no answer in time"
		if q.Status == "answered" {
			outcome = "Answer: " + q.Answer
		}
		if p := m.findPrompt(key); p != nil {
			cmds = append(cmds, m.closePrompt(key, promptOutcome(p, outcome)))
		}
	}
	for _, e := range f.Elevations {
		if strings.TrimSpace(e.ID) == "" {
			continue
		}
		key := remoteElevationKey(taskID, e.ID)
		if e.Status == "open" {
			if m.findPrompt(key) == nil && !m.closedPrompts[key] {
				var deadline time.Time
				if e.Deadline > 0 {
					deadline = time.Unix(e.Deadline, 0)
				}
				p := newElevationPrompt(key, e.Command, e.Cwd, e.Host, deadline, e.Attempt)
				p.id, p.taskID = e.ID, taskID
				p.remote = true
				p.respond = remoteElevationRespond
				cmds = append(cmds, m.openPrompt(p))
			}
			continue
		}
		if p := m.findPrompt(key); p != nil {
			cmds = append(cmds, m.closePrompt(key, promptOutcome(p, remoteElevationOutcome(e.Status))))
		}
	}
	return tea.Batch(cmds...)
}

func remoteElevationOutcome(status string) string {
	switch status {
	case "allowed":
		return "allowed"
	case "declined":
		return "declined"
	case "rejected":
		return "the answer was rejected"
	}
	return "no answer in time"
}

// pruneRemotePrompts drops the cards of tasks this view no longer follows. They come back from
// the task's stream when it is followed again.
func (m *chatModel) pruneRemotePrompts() {
	for i := 0; i < len(m.prompts); {
		p := m.prompts[i]
		task, ok := m.tasks[p.taskID]
		if p.taskID == "" || (ok && !m.listing && !m.deleted && task.TopicID == m.id && remoteStreamActive(task)) {
			i++
			continue
		}
		m.dropPrompt(p.key, "")
	}
}

// remoteQuestionRespond sends the answer to a question to the runtime.
func remoteQuestionRespond(m *chatModel, p *chatPrompt, resp chatPromptResponse) tea.Cmd {
	if resp.decline {
		return m.closePrompt(p.key, promptOutcome(p, "dismissed here; the task still waits for an answer"))
	}
	req := daemonruntime.AnswerQuestionRequest{QuestionID: p.id, Option: resp.option}
	if resp.option < 0 {
		req.Text = resp.text
	}
	p.resolving = true
	ctx, c, key, task, text := m.ctx, m.client, p.key, p.taskID, resp.text
	return func() tea.Msg {
		var out daemonruntime.AnswerQuestionResponse
		err := c.request(ctx, "POST", "/tasks/"+url.PathEscape(task)+"/answer", req, &out)
		if out.Answer != "" {
			text = out.Answer
		}
		return remotePromptResult{key: key, accepted: out.Answered, text: text, err: err}
	}
}

// remoteElevationRespond sends the password to the runtime that asked, over chat's connection to
// it, or sends a decline.
func remoteElevationRespond(m *chatModel, p *chatPrompt, resp chatPromptResponse) tea.Cmd {
	defer clear(resp.password)
	req := daemonruntime.AnswerElevationRequest{ElevationID: p.id, Client: "chat"}
	if resp.decline {
		req.Decline = true
	} else {
		if m.promptRefusal(p) != "" {
			return nil
		}
		req.Password = string(resp.password)
	}
	p.resolving = true
	ctx, c, key, task, decline := m.ctx, m.client, p.key, p.taskID, req.Decline
	return func() tea.Msg {
		var out daemonruntime.AnswerElevationResponse
		err := c.request(ctx, "POST", "/tasks/"+url.PathEscape(task)+"/elevation", req, &out)
		return remotePromptResult{key: key, accepted: out.Accepted, decline: decline, err: err}
	}
}

func (m *chatModel) applyRemotePromptResult(r remotePromptResult) tea.Cmd {
	p := m.findPrompt(r.key)
	if p == nil {
		if r.err != nil {
			m.notice = remoteErrorText(r.err)
		}
		return nil
	}
	p.resolving = false
	if r.err != nil {
		p.errText = "The runtime refused the answer: " + remoteErrorText(r.err)
		return nil
	}
	if !r.accepted {
		return m.closePrompt(r.key, promptOutcome(p, "already closed on the runtime"))
	}
	switch {
	case p.kind == chatPromptQuestion:
		return m.closePrompt(r.key, promptOutcome(p, "Answer: "+r.text))
	case r.decline:
		return m.closePrompt(r.key, promptOutcome(p, "declined"))
	}
	return m.closePrompt(r.key, promptOutcome(p, "password sent"))
}

// remoteErrorText is a runtime error as the person reads it: the runtime's own message for a
// refused request, when it gave one.
func remoteErrorText(err error) string {
	var he *remoteHTTPError
	if errors.As(err, &he) && he.detail != "" {
		return he.detail
	}
	return err.Error()
}

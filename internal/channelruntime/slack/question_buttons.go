package slack

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/internal/slackclient"
)

const (
	// A choice's action ID is this prefix and its index: action IDs are unique within a block.
	slackQuestionActionPrefix = "morph_ask_"
	slackQuestionValuePrefix  = "aq:"
)

// slackAsksUser reports whether a job's run may use ask_user: a DM with a person, where one person
// answers.
func slackAsksUser(job slackJob) bool {
	return strings.EqualFold(strings.TrimSpace(job.ChatType), "im") && !job.FromIsAgent
}

func slackQuestionButtonValue(questionID string, option int) string {
	return slackQuestionValuePrefix + strings.TrimSpace(questionID) + ":" + strconv.Itoa(option)
}

func parseSlackQuestionButtonValue(raw string) (questionID string, option int, ok bool) {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, slackQuestionValuePrefix) {
		return "", 0, false
	}
	questionID, index, found := strings.Cut(strings.TrimPrefix(raw, slackQuestionValuePrefix), ":")
	questionID = strings.TrimSpace(questionID)
	option, err := strconv.Atoi(strings.TrimSpace(index))
	if !found || questionID == "" || err != nil || option < 0 {
		return "", 0, false
	}
	return questionID, option, true
}

// parseSlackQuestionAction finds a question button press in an interactive envelope.
func parseSlackQuestionAction(envelope slackSocketEnvelope) (questionID string, option int, ok bool, err error) {
	if strings.TrimSpace(envelope.Type) != "interactive" || len(envelope.Payload) == 0 {
		return "", 0, false, nil
	}
	var payload slackInteractivePayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return "", 0, false, err
	}
	if strings.TrimSpace(payload.Type) != "block_actions" {
		return "", 0, false, nil
	}
	for _, action := range payload.Actions {
		if !strings.HasPrefix(strings.TrimSpace(action.ActionID), slackQuestionActionPrefix) {
			continue
		}
		if questionID, option, ok := parseSlackQuestionButtonValue(action.Value); ok {
			return questionID, option, true, nil
		}
	}
	return "", 0, false, nil
}

func slackQuestionText(q taskruntime.UserQuestion) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(q.Text))
	for i, option := range q.Options {
		if i == 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "\n%d. *%s*", i+1, escapeSlackInline(option.Label))
		if option.Description != "" {
			b.WriteString(" - " + escapeSlackInline(option.Description))
		}
	}
	return b.String()
}

func slackQuestionHint(q taskruntime.UserQuestion) string {
	if len(q.Options) > 0 {
		return "Choose one, or reply with your own answer."
	}
	return "Reply with your answer."
}

func buildSlackQuestionBlocks(q taskruntime.UserQuestion) []slackclient.Block {
	blocks := []slackclient.Block{{
		"type": "section",
		"text": map[string]any{"type": "mrkdwn", "text": slackQuestionText(q)},
	}}
	if len(q.Options) > 0 {
		elements := make([]map[string]any, 0, len(q.Options))
		for i, option := range q.Options {
			elements = append(elements, map[string]any{
				"type":      "button",
				"text":      map[string]any{"type": "plain_text", "text": option.Label},
				"action_id": slackQuestionActionPrefix + strconv.Itoa(i),
				"value":     slackQuestionButtonValue(q.ID, i),
			})
		}
		blocks = append(blocks, slackclient.Block{"type": "actions", "elements": elements})
	}
	return append(blocks, slackclient.Block{
		"type":     "context",
		"elements": []map[string]any{{"type": "mrkdwn", "text": slackQuestionHint(q)}},
	})
}

func buildSlackSettledQuestionBlocks(q taskruntime.UserQuestion, answer *runtimecontrol.Answer) []slackclient.Block {
	return []slackclient.Block{
		{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": strings.TrimSpace(q.Text)},
		},
		{
			"type":     "context",
			"elements": []map[string]any{{"type": "mrkdwn", "text": escapeSlackInline(taskruntime.UserQuestionAnswerLabel(answer))}},
		},
	}
}

// showSlackQuestion posts a question to the job's conversation with a button per choice. Settling
// it updates the message to show the answer, without the buttons.
func (s *slackRuntimeState) showSlackQuestion(job slackJob) taskruntime.ShowUserQuestionFunc {
	return func(ctx context.Context, q taskruntime.UserQuestion) (func(context.Context, *runtimecontrol.Answer), error) {
		if s.api == nil {
			return nil, fmt.Errorf("slack api is unavailable")
		}
		ref, err := s.api.postMessageWithBlocksResult(ctx, job.ChannelID, strings.TrimSpace(q.Text), job.ThreadTS, buildSlackQuestionBlocks(q))
		if err != nil {
			return nil, err
		}
		return func(ctx context.Context, answer *runtimecontrol.Answer) {
			fallback := strings.TrimSpace(q.Text) + "\n" + taskruntime.UserQuestionAnswerLabel(answer)
			if err := s.api.updateMessageWithBlocks(ctx, ref.ChannelID, ref.MessageTS, fallback, buildSlackSettledQuestionBlocks(q, answer)); err != nil {
				s.logger.Warn("slack_question_settle_error", "question_id", q.ID, "channel_id", ref.ChannelID, "error", err.Error())
			}
		}, nil
	}
}

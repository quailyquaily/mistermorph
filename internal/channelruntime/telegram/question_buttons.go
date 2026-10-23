package telegram

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

const telegramQuestionCallbackPrefix = "aq:"

// telegramAsksUser reports whether a job's run may use ask_user: a private chat with a person,
// where one person answers.
func telegramAsksUser(job telegramJob) bool {
	return strings.EqualFold(strings.TrimSpace(job.ChatType), "private") && !job.FromIsAgent
}

func telegramQuestionCallbackData(questionID string, option int) string {
	return telegramQuestionCallbackPrefix + strings.TrimSpace(questionID) + ":" + strconv.Itoa(option)
}

func parseTelegramQuestionCallbackData(raw string) (questionID string, option int, ok bool) {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, telegramQuestionCallbackPrefix) {
		return "", 0, false
	}
	questionID, index, found := strings.Cut(strings.TrimPrefix(raw, telegramQuestionCallbackPrefix), ":")
	questionID = strings.TrimSpace(questionID)
	option, err := strconv.Atoi(strings.TrimSpace(index))
	if !found || questionID == "" || err != nil || option < 0 {
		return "", 0, false
	}
	return questionID, option, true
}

// telegramQuestionText is the question message, in Markdown: the question, then each choice with
// its description.
func telegramQuestionText(q taskruntime.UserQuestion) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(q.Text))
	if len(q.Options) > 0 {
		b.WriteString("\n")
		for i, option := range q.Options {
			fmt.Fprintf(&b, "\n%d. **%s**", i+1, option.Label)
			if option.Description != "" {
				b.WriteString(" - " + option.Description)
			}
		}
		b.WriteString("\n\n_Tap a choice, or reply with your own answer._")
	} else {
		b.WriteString("\n\n_Reply with your answer._")
	}
	return b.String()
}

func telegramSettledQuestionText(q taskruntime.UserQuestion, answer *runtimecontrol.Answer) string {
	return strings.TrimSpace(q.Text) + "\n\n" + taskruntime.UserQuestionAnswerLabel(answer)
}

func telegramQuestionReplyMarkup(q taskruntime.UserQuestion) *telegramInlineKeyboardMarkup {
	if len(q.Options) == 0 {
		return nil
	}
	rows := make([][]telegramInlineKeyboardButton, 0, len(q.Options))
	for i, option := range q.Options {
		rows = append(rows, []telegramInlineKeyboardButton{{
			Text:         option.Label,
			CallbackData: telegramQuestionCallbackData(q.ID, i),
		}})
	}
	return &telegramInlineKeyboardMarkup{InlineKeyboard: rows}
}

// showTelegramQuestion sends a question to the job's chat with a button per choice. Settling it
// edits the message to show the answer, which removes the buttons.
func (s *telegramRuntimeState) showTelegramQuestion(job telegramJob) taskruntime.ShowUserQuestionFunc {
	return func(ctx context.Context, q taskruntime.UserQuestion) (func(context.Context, *runtimecontrol.Answer), error) {
		if s.api == nil {
			return nil, fmt.Errorf("telegram api is unavailable")
		}
		messageID, err := s.api.sendMessageHTMLReplyInThreadWithMessageIDAndMarkup(ctx, job.ChatID, job.MessageThreadID, telegramQuestionText(q), true, 0, telegramQuestionReplyMarkup(q))
		if err != nil {
			return nil, err
		}
		return func(ctx context.Context, answer *runtimecontrol.Answer) {
			if messageID == 0 {
				return
			}
			if err := s.api.editMessageHTML(ctx, job.ChatID, messageID, telegramSettledQuestionText(q, answer), true); err != nil {
				s.logger.Warn("telegram_question_settle_error", "question_id", q.ID, "chat_id", job.ChatID, "error", err.Error())
			}
		}, nil
	}
}

// handleQuestionCallback answers an open question from its button. A stale button gets a notice.
func (s *telegramRuntimeState) handleQuestionCallback(ctx context.Context, query *telegramCallbackQuery) bool {
	if query == nil {
		return false
	}
	questionID, option, ok := parseTelegramQuestionCallbackData(query.Data)
	if !ok {
		return false
	}
	_, chosen := s.runControl.Choose("telegram", questionID, option)
	if s.api != nil && strings.TrimSpace(query.ID) != "" {
		text := ""
		if !chosen {
			text = "This question is closed."
		}
		if err := s.api.answerCallbackQuery(ctx, query.ID, text, false); err != nil {
			s.logger.Warn("telegram_question_callback_answer_error", "question_id", questionID, "error", err.Error())
		}
	}
	return true
}

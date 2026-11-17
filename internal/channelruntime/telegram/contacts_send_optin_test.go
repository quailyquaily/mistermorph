package telegram

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
)

// A Telegram group chat gets contacts_send only from $contacts_send, also with tool search on.
func TestTelegramGroupChatKeepsContactsSendOptIn(t *testing.T) {
	runtimetest.CheckContactsSendOptIn(t, func(t testing.TB, rt *taskruntime.Runtime, text string, group bool) error {
		job := telegramJob{TaskID: "task-1", ConversationKey: "tg:2002", ChatID: 2002, ChatType: "private", FromUserID: 2002, FromUsername: "bob", MessageID: 7, Text: text}
		if group {
			job.ConversationKey, job.ChatID, job.ChatType = "tg:-3003", -3003, "supergroup"
		}
		send := func(context.Context, int64, int64, string, string) error { return nil }
		_, _, _, _, err := runTelegramTask(context.Background(), rt, nil, t.TempDir(), 0, nil, job, "morph_bot", nil, nil, 0, runtimeTaskOptions{}, nil, send)
		return err
	})
}

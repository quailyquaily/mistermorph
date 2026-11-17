package line

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
)

// A LINE group gets contacts_send only from $contacts_send, also with tool search on.
func TestLineGroupChatKeepsContactsSendOptIn(t *testing.T) {
	runtimetest.CheckContactsSendOptIn(t, func(t testing.TB, rt *taskruntime.Runtime, text string, group bool) error {
		job := lineJob{TaskID: "task-1", ConversationKey: "line:U2002", ChatID: "U2002", ChatType: "private", FromUserID: "U2002", FromUsername: "bob", Text: text}
		if group {
			job.ConversationKey, job.ChatID, job.ChatType = "line:C3003", "C3003", "group"
		}
		_, _, _, err := runLineTask(context.Background(), rt, job, nil, nil, runtimeTaskOptions{FileCacheDir: t.TempDir()}, nil)
		return err
	})
}

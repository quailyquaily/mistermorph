package lark

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
)

// A Lark group gets contacts_send only from $contacts_send, also with tool search on.
func TestLarkGroupChatKeepsContactsSendOptIn(t *testing.T) {
	runtimetest.CheckContactsSendOptIn(t, func(t testing.TB, rt *taskruntime.Runtime, text string, group bool) error {
		job := larkJob{TaskID: "task-1", ConversationKey: "lark:oc_p2p", ChatID: "oc_p2p", ChatType: "p2p", FromUserID: "ou_bob", Text: text}
		if group {
			job.ConversationKey, job.ChatID, job.ChatType = "lark:oc_group", "oc_group", "group"
		}
		_, _, _, err := runLarkTask(context.Background(), rt, job, nil, nil, runtimeTaskOptions{FileCacheDir: t.TempDir()}, nil)
		return err
	})
}

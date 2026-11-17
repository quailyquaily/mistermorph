package mixin

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
)

// A Mixin group gets contacts_send only from $contacts_send, also with tool search on.
func TestMixinGroupChatKeepsContactsSendOptIn(t *testing.T) {
	runtimetest.CheckContactsSendOptIn(t, func(t testing.TB, rt *taskruntime.Runtime, text string, group bool) error {
		job := mixinJob{TaskID: "task-1", ConversationKey: "mixin:conv-bob", ConversationID: "conv-bob", ChatType: "CONTACT", FromUserID: "user-bob", Text: text}
		if group {
			job.ConversationKey, job.ConversationID, job.ChatType = "mixin:conv-group", "conv-group", "GROUP"
		}
		_, _, _, err := runMixinTask(context.Background(), rt, nil, job, nil, nil, nil)
		return err
	})
}

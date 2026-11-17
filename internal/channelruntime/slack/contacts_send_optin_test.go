package slack

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
)

// A Slack channel gets contacts_send only from $contacts_send, also with tool search on.
func TestSlackGroupChatKeepsContactsSendOptIn(t *testing.T) {
	runtimetest.CheckContactsSendOptIn(t, func(t testing.TB, rt *taskruntime.Runtime, text string, group bool) error {
		job := slackJob{TaskID: "task-1", ConversationKey: "slack:T1:D2002", TeamID: "T1", ChannelID: "D2002", ChatType: "im", UserID: "U2002", Username: "bob", MessageTS: "1.1", Text: text}
		if group {
			job.ConversationKey, job.ChannelID, job.ChatType = "slack:T1:C3003", "C3003", "channel"
		}
		_, _, _, _, err := runSlackTask(context.Background(), rt, nil, job, nil, nil, nil, nil, t.TempDir(), runtimeTaskOptions{}, nil, nil)
		return err
	})
}

package discord

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"

	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
)

// A Discord server channel gets contacts_send only from $contacts_send, also with tool search on.
func TestDiscordGroupChatKeepsContactsSendOptIn(t *testing.T) {
	runtimetest.CheckContactsSendOptIn(t, func(t testing.TB, rt *taskruntime.Runtime, text string, group bool) error {
		job := discordJob{TaskID: "task-1", ConversationKey: "discord:2002", ChannelID: "2002", ChatType: discordbus.ChatTypePrivate, UserID: "2002", Username: "bob", MessageID: "7", Text: text, FileCacheDir: t.TempDir()}
		if group {
			job.ConversationKey, job.ChannelID, job.ChatType = "discord:3003", "3003", discordbus.ChatTypeGroup
		}
		_, err := runDiscordTask(context.Background(), rt, discordTaskEnv{logger: rt.Logger}, job, nil, nil, nil)
		return err
	})
}

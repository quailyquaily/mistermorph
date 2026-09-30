package discordcmd

import (
	awarenessruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	discordruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/discord"
)

type Dependencies struct {
	awarenessruntime.Dependencies
	HandleModelCommand discordruntime.HandleModelCommandFunc
	HandleSkillCommand discordruntime.HandleSkillCommandFunc
}

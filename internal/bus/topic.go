package bus

const (
	TopicShareProactiveV1 = "share.proactive.v1"
	TopicDMCheckinV1      = "dm.checkin.v1"
	TopicDMReplyV1        = "dm.reply.v1"
	TopicChatMessage      = "chat.message"
)

func IsDialogueTopic(topic string) bool {
	switch topic {
	case TopicShareProactiveV1, TopicDMCheckinV1, TopicDMReplyV1, TopicChatMessage:
		return true
	default:
		return false
	}
}


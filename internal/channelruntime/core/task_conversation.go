package core

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func BuildTaskConversation(conversationID, conversationType, senderID, senderName, selfID string, mentionIDs []string) *taskdomain.TaskConversation {
	participants := make([]taskdomain.TaskParticipant, 0, 1+len(mentionIDs))
	senderID = strings.TrimSpace(senderID)
	senderName = strings.TrimSpace(senderName)
	selfID = strings.TrimSpace(selfID)
	if senderID != "" && !strings.EqualFold(senderID, selfID) {
		participants = append(participants, taskdomain.TaskParticipant{ID: senderID, Nickname: senderName})
	}
	for _, mentionID := range mentionIDs {
		mentionID = strings.TrimSpace(mentionID)
		if mentionID != "" && !strings.EqualFold(mentionID, selfID) {
			participants = append(participants, taskdomain.TaskParticipant{ID: mentionID})
		}
	}
	return taskdomain.NormalizeTaskConversation(&taskdomain.TaskConversation{
		ConversationID:   conversationID,
		ConversationType: conversationType,
		Participants:     participants,
	})
}

// ConversationWithAudience records who could hear the task on its conversation, creating the
// conversation when the channel had nothing else to record.
func ConversationWithAudience(conversation *taskdomain.TaskConversation, who audience.Audience) *taskdomain.TaskConversation {
	if who.IsZero() {
		return conversation
	}
	if conversation == nil {
		conversation = &taskdomain.TaskConversation{}
	}
	conversation.Audience = who.String()
	return conversation
}

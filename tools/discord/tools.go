// Package discord holds the tools the agent can use in a Discord conversation.
package discord

import "context"

// API is the Discord transport the tools need.
type API interface {
	AddReaction(ctx context.Context, channelID, messageID, emoji string) error
	SendFile(ctx context.Context, channelID, filePath, filename, content, replyToMessageID string) error
}

// Reaction is the last reaction a tool added, so the runtime can tell a group message was answered
// with one.
type Reaction struct {
	ChannelID string
	MessageID string
	Emoji     string
	Source    string
}

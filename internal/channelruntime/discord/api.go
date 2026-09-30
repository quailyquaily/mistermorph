package discord

import (
	"context"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/discordapi"
)

// discordAPI is the part of discordapi.Client the runtime uses.
type discordAPI interface {
	Me(context.Context) (discordapi.User, error)
	GatewayBot(context.Context) (discordapi.GatewayBot, error)
	Channel(context.Context, string) (discordapi.Channel, error)
	CreateMessage(context.Context, string, discordapi.MessageCreate) (discordapi.Message, error)
	EditMessage(context.Context, string, string, discordapi.MessageEdit) (discordapi.Message, error)
	TriggerTyping(context.Context, string) error
	AddReaction(context.Context, string, string, string) error
	CreateDM(context.Context, string) (discordapi.Channel, error)
	RespondInteraction(context.Context, string, string, discordapi.InteractionResponse) error
	EditInteractionResponse(context.Context, string, string, discordapi.MessageEdit) (discordapi.Message, error)
	DeleteInteractionResponse(context.Context, string, string) error
	SetGlobalCommands(context.Context, string, []discordapi.ApplicationCommand) error
	DownloadAttachment(context.Context, string, int64) ([]byte, string, error)
}

type discordGateway interface {
	Run(context.Context, discordapi.EventHandler) error
}

const discordTypingInterval = 8 * time.Second

// sendDiscordText sends text to a channel, split to Discord's length limit. The first part replies
// to replyTo when it is set; no part pings anyone.
func sendDiscordText(ctx context.Context, api discordAPI, channelID, text, replyTo string) ([]discordapi.Message, error) {
	parts := discordapi.SplitContent(text, discordapi.MaxMessageLength)
	if len(parts) == 0 {
		return nil, fmt.Errorf("discord message text is empty")
	}
	sent := make([]discordapi.Message, 0, len(parts))
	for index, part := range parts {
		msg := discordapi.MessageCreate{Content: part, AllowedMentions: discordapi.NoMentions()}
		if index == 0 {
			msg.MessageReference = discordReplyReference(replyTo)
		}
		message, err := api.CreateMessage(ctx, channelID, msg)
		if err != nil {
			return sent, err
		}
		sent = append(sent, message)
	}
	return sent, nil
}

func discordReplyReference(messageID string) *discordapi.MessageReference {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return nil
	}
	failIfNotExists := false
	return &discordapi.MessageReference{MessageID: messageID, FailIfNotExists: &failIfNotExists}
}

// keepTyping shows "typing…" in the channel until the returned stop is called: Discord shows it for
// about ten seconds, so it is renewed every eight.
func keepTyping(ctx context.Context, api discordAPI, channelID string) (stop func()) {
	typingCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(discordTypingInterval)
		defer ticker.Stop()
		for {
			_ = api.TriggerTyping(typingCtx, channelID)
			select {
			case <-typingCtx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

// discordToolAPI adapts the client to tools/discord.
type discordToolAPI struct {
	api discordAPI
}

func (a discordToolAPI) AddReaction(ctx context.Context, channelID, messageID, emoji string) error {
	return a.api.AddReaction(ctx, channelID, messageID, emoji)
}

func (a discordToolAPI) SendFile(ctx context.Context, channelID, filePath, filename, content, replyTo string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(filename)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	_, err = a.api.CreateMessage(ctx, channelID, discordapi.MessageCreate{
		Content: truncateDiscordText(content, discordapi.MaxMessageLength), AllowedMentions: discordapi.NoMentions(), MessageReference: discordReplyReference(replyTo),
		Files: []discordapi.File{{Name: filename, ContentType: contentType, Data: data}},
	})
	return err
}

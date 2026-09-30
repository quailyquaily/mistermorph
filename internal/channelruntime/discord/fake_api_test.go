package discord

import (
	"context"
	"fmt"
	"strconv"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/discordapi"
)

type fakeDiscordAPI struct {
	mu        sync.Mutex
	created   []fakeCreated
	edits     []fakeEdit
	channels  map[string]discordapi.Channel
	downloads map[string][]byte
	nextID    int
	typing    int
	// Interaction responses: edits of placeholders, deletions, and registered commands.
	responseEdits   []string
	responseDeletes []string
	commands        []discordapi.ApplicationCommand
	responses       []discordapi.InteractionResponse
}

type fakeCreated struct {
	ChannelID string
	Message   discordapi.MessageCreate
}

type fakeEdit struct {
	ChannelID string
	MessageID string
	Edit      discordapi.MessageEdit
}

func (f *fakeDiscordAPI) Me(context.Context) (discordapi.User, error) {
	return discordapi.User{ID: "42", Username: "morph", Bot: true}, nil
}

func (f *fakeDiscordAPI) GatewayBot(context.Context) (discordapi.GatewayBot, error) {
	return discordapi.GatewayBot{URL: "wss://gateway.invalid"}, nil
}

func (f *fakeDiscordAPI) Channel(_ context.Context, id string) (discordapi.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if channel, ok := f.channels[id]; ok {
		return channel, nil
	}
	return discordapi.Channel{}, fmt.Errorf("unknown channel %s", id)
}

func (f *fakeDiscordAPI) CreateMessage(_ context.Context, channelID string, msg discordapi.MessageCreate) (discordapi.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.created = append(f.created, fakeCreated{ChannelID: channelID, Message: msg})
	return discordapi.Message{ID: strconv.Itoa(9000 + f.nextID), ChannelID: channelID, Content: msg.Content}, nil
}

func (f *fakeDiscordAPI) EditMessage(_ context.Context, channelID, messageID string, edit discordapi.MessageEdit) (discordapi.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.edits = append(f.edits, fakeEdit{ChannelID: channelID, MessageID: messageID, Edit: edit})
	return discordapi.Message{ID: messageID, ChannelID: channelID}, nil
}

func (f *fakeDiscordAPI) TriggerTyping(context.Context, string) error {
	f.mu.Lock()
	f.typing++
	f.mu.Unlock()
	return nil
}

func (f *fakeDiscordAPI) AddReaction(context.Context, string, string, string) error { return nil }

func (f *fakeDiscordAPI) CreateDM(_ context.Context, userID string) (discordapi.Channel, error) {
	return discordapi.Channel{ID: "7" + userID, Type: discordapi.ChannelTypeDM}, nil
}

func (f *fakeDiscordAPI) RespondInteraction(_ context.Context, _ string, _ string, response discordapi.InteractionResponse) error {
	f.mu.Lock()
	f.responses = append(f.responses, response)
	f.mu.Unlock()
	return nil
}

func (f *fakeDiscordAPI) DownloadAttachment(_ context.Context, url string, _ int64) ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if raw, ok := f.downloads[url]; ok {
		return raw, "image/png", nil
	}
	return nil, "", fmt.Errorf("not found")
}

func (f *fakeDiscordAPI) EditInteractionResponse(_ context.Context, appID, token string, edit discordapi.MessageEdit) (discordapi.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.responseEdits = append(f.responseEdits, appID+"/"+token+"/"+*edit.Content)
	return discordapi.Message{ID: "8000"}, nil
}

func (f *fakeDiscordAPI) DeleteInteractionResponse(_ context.Context, appID, token string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.responseDeletes = append(f.responseDeletes, appID+"/"+token)
	return nil
}

func (f *fakeDiscordAPI) SetGlobalCommands(_ context.Context, _ string, commands []discordapi.ApplicationCommand) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commands = commands
	return nil
}

package discord

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/imagehistory"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
	"github.com/quailyquaily/mistermorph/internal/filecache"
	"github.com/quailyquaily/mistermorph/internal/imagemime"
)

const (
	discordImageMaxBytes  = int64(5 << 20)
	discordLLMMaxImages   = 3
	discordDownloadTimout = 30 * time.Second
)

// discordAllowlist holds the configured allowlists; an empty list allows everything it covers.
type discordAllowlist struct {
	guilds   map[string]bool
	channels map[string]bool
	users    map[string]bool
}

func newDiscordAllowlist(guildIDs, channelIDs, userIDs []string) (discordAllowlist, error) {
	build := func(field string, values []string) (map[string]bool, error) {
		out := make(map[string]bool, len(values))
		for _, value := range values {
			id, err := discordbus.NormalizeSnowflake(field, value)
			if err != nil {
				return nil, fmt.Errorf("discord %s: %q is not a Discord ID", field, value)
			}
			out[id] = true
		}
		return out, nil
	}
	guilds, err := build("allowed_guild_ids", guildIDs)
	if err != nil {
		return discordAllowlist{}, err
	}
	channels, err := build("allowed_channel_ids", channelIDs)
	if err != nil {
		return discordAllowlist{}, err
	}
	users, err := build("allowed_user_ids", userIDs)
	if err != nil {
		return discordAllowlist{}, err
	}
	return discordAllowlist{guilds: guilds, channels: channels, users: users}, nil
}

// serverAllowed reports whether a server channel is allowed: its server must be listed (or no
// server is), and the channel, or the channel a thread belongs to, must be listed (or none is).
func (a discordAllowlist) serverAllowed(guildID string, channel discordapi.Channel) bool {
	if len(a.guilds) > 0 && !a.guilds[strings.TrimSpace(guildID)] {
		return false
	}
	if len(a.channels) == 0 || a.channels[strings.TrimSpace(channel.ID)] {
		return true
	}
	return channel.IsThread() && a.channels[strings.TrimSpace(channel.ParentID)]
}

// dmAllowed reports whether a DM is allowed. A bot needs to be listed or paired even when the list is
// empty, so two bots never answer each other in a loop.
func (a discordAllowlist) dmAllowed(userID string, isBot, pairedAgent bool) bool {
	if pairedAgent || a.users[strings.TrimSpace(userID)] {
		return true
	}
	return !isBot && len(a.users) == 0
}

type discordIngress struct {
	api      discordAPI
	botID    string
	cacheDir string
	logger   *slog.Logger
	// authorize decides whether a message may be handled, before any attachment is downloaded.
	authorize func(context.Context, discordbus.InboundMessage, discordapi.Channel) (bool, error)
	// downloadUnaddressed downloads images of server messages that do not address the bot, for the
	// group trigger modes that read every message.
	downloadUnaddressed bool

	mu       sync.Mutex
	channels map[string]discordapi.Channel
	guilds   map[string]string
}

func newDiscordIngress(api discordAPI, botID, cacheDir string, logger *slog.Logger) *discordIngress {
	if logger == nil {
		logger = slog.Default()
	}
	return &discordIngress{
		api: api, botID: strings.TrimSpace(botID), cacheDir: strings.TrimSpace(cacheDir), logger: logger,
		channels: make(map[string]discordapi.Channel), guilds: make(map[string]string),
	}
}

// rememberGuild caches the names of a server and its channels from GUILD_CREATE, so allowlist
// checks and chat profiles do not call Discord.
func (i *discordIngress) rememberGuild(guild discordapi.Guild) {
	guildID := strings.TrimSpace(guild.ID)
	if guildID == "" {
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.guilds[guildID] = strings.TrimSpace(guild.Name)
	for _, list := range [][]discordapi.Channel{guild.Channels, guild.Threads} {
		for _, channel := range list {
			if strings.TrimSpace(channel.ID) == "" {
				continue
			}
			if channel.GuildID == "" {
				channel.GuildID = guildID
			}
			i.channels[channel.ID] = channel
		}
	}
}

func (i *discordIngress) guildName(guildID string) string {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.guilds[strings.TrimSpace(guildID)]
}

// channel returns a channel from the cache, or from Discord (once) when a thread was created after
// GUILD_CREATE.
func (i *discordIngress) channel(ctx context.Context, channelID string) (discordapi.Channel, error) {
	i.mu.Lock()
	channel, found := i.channels[channelID]
	i.mu.Unlock()
	if found {
		return channel, nil
	}
	if i.api == nil {
		return discordapi.Channel{ID: channelID}, nil
	}
	channel, err := i.api.Channel(ctx, channelID)
	if err != nil {
		return discordapi.Channel{}, err
	}
	i.mu.Lock()
	i.channels[channelID] = channel
	i.mu.Unlock()
	return channel, nil
}

// chatName is the chat profile name: "Server #channel" in servers, the user's name in DMs.
func (i *discordIngress) chatName(inbound discordbus.InboundMessage, channel discordapi.Channel) string {
	if inbound.ChatType == discordbus.ChatTypePrivate {
		return firstNonEmpty(inbound.DisplayName, inbound.Username)
	}
	name := strings.TrimSpace(channel.Name)
	if name != "" {
		name = "#" + name
	}
	return strings.TrimSpace(strings.TrimSpace(i.guildName(inbound.GuildID)) + " " + name)
}

// Normalize turns a MESSAGE_CREATE into an inbound message. It returns false for messages the bot
// does not handle: its own, system and webhook messages, empty ones, and those the allowlists reject.
func (i *discordIngress) Normalize(ctx context.Context, msg discordapi.Message) (discordbus.InboundMessage, discordapi.Channel, bool, error) {
	author := msg.Author
	if strings.TrimSpace(author.ID) == "" || author.ID == i.botID || author.System || strings.TrimSpace(msg.WebhookID) != "" {
		return discordbus.InboundMessage{}, discordapi.Channel{}, false, nil
	}
	if msg.Type != discordapi.MessageTypeDefault && msg.Type != discordapi.MessageTypeReply {
		return discordbus.InboundMessage{}, discordapi.Channel{}, false, nil
	}
	chatType := discordbus.ChatTypePrivate
	if strings.TrimSpace(msg.GuildID) != "" {
		chatType = discordbus.ChatTypeGroup
	}
	// Other bots in a server are ignored: they cannot be told apart from a loop.
	if chatType == discordbus.ChatTypeGroup && author.Bot {
		return discordbus.InboundMessage{}, discordapi.Channel{}, false, nil
	}
	channel := discordapi.Channel{ID: msg.ChannelID, GuildID: msg.GuildID}
	if chatType == discordbus.ChatTypeGroup {
		fetched, err := i.channel(ctx, msg.ChannelID)
		if err != nil {
			return discordbus.InboundMessage{}, discordapi.Channel{}, false, fmt.Errorf("load discord channel: %w", err)
		}
		channel = fetched
	}
	mentions := make([]string, 0, len(msg.Mentions)+1)
	addressed := false
	for _, user := range msg.Mentions {
		if id := strings.TrimSpace(user.ID); id != "" {
			mentions = append(mentions, id)
			addressed = addressed || id == i.botID
		}
	}
	replyTo := ""
	if msg.MessageReference != nil && strings.TrimSpace(msg.MessageReference.ChannelID) == strings.TrimSpace(msg.ChannelID) {
		replyTo = strings.TrimSpace(msg.MessageReference.MessageID)
	}
	// A reply to the bot addresses it as a mention does; the bot's ID in the mentions is what marks a
	// message as addressed from here on.
	if !addressed && msg.ReferencedMessage != nil && msg.ReferencedMessage.Author.ID == i.botID && i.botID != "" {
		mentions = append(mentions, i.botID)
		addressed = true
	}
	displayName := author.DisplayName()
	if msg.Member != nil && strings.TrimSpace(msg.Member.Nick) != "" {
		displayName = strings.TrimSpace(msg.Member.Nick)
	}
	text := stripDiscordBotMention(msg.Content, i.botID)
	var others []string
	for _, attachment := range msg.Attachments {
		if !isDiscordImage(attachment) {
			others = append(others, fmt.Sprintf("[attachment: %s (%s)]", strings.TrimSpace(attachment.Filename), formatDiscordSize(attachment.Size)))
		}
	}
	if len(others) > 0 {
		text = strings.TrimSpace(text + "\n" + strings.Join(others, "\n"))
	}
	sentAt := msg.Timestamp.UTC()
	inbound := discordbus.InboundMessage{
		ChannelID: msg.ChannelID, GuildID: msg.GuildID, MessageID: msg.ID, SentAt: sentAt, ChatType: chatType,
		UserID: author.ID, Username: author.Username, DisplayName: displayName, FromIsAgent: author.Bot,
		Text: text, ReplyToMessageID: replyTo, MentionUserIDs: mentions,
	}
	if i.authorize != nil {
		allowed, err := i.authorize(ctx, inbound, channel)
		if err != nil || !allowed {
			return discordbus.InboundMessage{}, discordapi.Channel{}, false, err
		}
	}
	// Images are downloaded only for messages the bot may act on: in strict mode, only when it is
	// addressed.
	if chatType == discordbus.ChatTypePrivate || addressed || i.downloadUnaddressed {
		inbound.ImageAttachments = i.downloadImages(ctx, msg)
	}
	if strings.TrimSpace(inbound.Text) == "" {
		if len(inbound.ImageAttachments) == 0 {
			return discordbus.InboundMessage{}, discordapi.Channel{}, false, nil
		}
		inbound.Text = "User sent an image."
	}
	return inbound, channel, true, nil
}

func (i *discordIngress) downloadImages(ctx context.Context, msg discordapi.Message) []busruntime.ImageAttachment {
	var out []busruntime.ImageAttachment
	for _, attachment := range msg.Attachments {
		if len(out) >= discordLLMMaxImages {
			break
		}
		if !isDiscordImage(attachment) {
			continue
		}
		path, contentType, err := i.downloadImage(ctx, attachment)
		if err != nil {
			i.logger.Warn("discord_image_download_failed", "channel_id", msg.ChannelID, "message_id", msg.ID, "attachment_id", attachment.ID, "error", err.Error())
			continue
		}
		out = append(out, busruntime.ImageAttachment{
			Path: path, SourceMessageID: msg.ID, SourceAttachmentID: attachment.ID, MIMEType: contentType,
		})
	}
	return out
}

func (i *discordIngress) downloadImage(ctx context.Context, attachment discordapi.Attachment) (string, string, error) {
	if attachment.Size > discordImageMaxBytes {
		return "", "", fmt.Errorf("image is %d bytes, over %d", attachment.Size, discordImageMaxBytes)
	}
	if _, err := discordbus.NormalizeSnowflake("attachment_id", attachment.ID); err != nil {
		return "", "", err
	}
	dir, err := imagehistory.DownloadDir(i.cacheDir, "", string(busruntime.ChannelDiscord))
	if err != nil {
		return "", "", err
	}
	name := filecache.SanitizeFilename(strings.TrimSpace(attachment.Filename))
	if name == "" {
		name = "image"
	}
	if filepath.Ext(name) == "" {
		name += imagemime.Extension(attachment.ContentType)
	}
	path := filepath.Join(dir, "discord_"+attachment.ID+"_"+name)
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		return path, attachment.ContentType, nil
	}
	if i.api == nil {
		return "", "", fmt.Errorf("discord api is unavailable")
	}
	downloadCtx, cancel := context.WithTimeout(ctx, discordDownloadTimout)
	defer cancel()
	raw, contentType, err := i.api.DownloadAttachment(downloadCtx, attachment.URL, discordImageMaxBytes)
	if err != nil {
		return "", "", err
	}
	if contentType = strings.TrimSpace(contentType); contentType == "" || !strings.HasPrefix(contentType, "image/") {
		contentType = strings.TrimSpace(attachment.ContentType)
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return "", "", err
	}
	tmpPath := tmp.Name()
	if _, err = tmp.Write(raw); err == nil {
		err = tmp.Chmod(0o600)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmpPath, path)
	}
	if err != nil {
		_ = os.Remove(tmpPath)
		return "", "", err
	}
	return path, contentType, nil
}

func isDiscordImage(attachment discordapi.Attachment) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(attachment.ContentType)), "image/")
}

// stripDiscordBotMention removes mentions of the bot (<@id> and the older <@!id>); other mentions
// stay, since they say who the message is about.
func stripDiscordBotMention(text, botID string) string {
	botID = strings.TrimSpace(botID)
	if botID != "" {
		text = strings.ReplaceAll(text, "<@"+botID+">", "")
		text = strings.ReplaceAll(text, "<@!"+botID+">", "")
	}
	return strings.TrimSpace(text)
}

func formatDiscordSize(size int64) string {
	switch {
	case size >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(size)/(1<<20))
	case size >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(size)/(1<<10))
	default:
		return fmt.Sprintf("%d B", size)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

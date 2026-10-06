package contactsruntime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
	mixinbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/mixin"
	slackbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/slack"
	telegrambus "github.com/quailyquaily/mistermorph/internal/bus/adapters/telegram"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
	"github.com/quailyquaily/mistermorph/internal/livesend"
	"github.com/quailyquaily/mistermorph/internal/mixinapi"
	"github.com/quailyquaily/mistermorph/internal/telegramapi"
)

// File size limits per channel. contacts_send never uploads more than 20 MiB; Discord's file tool
// default is lower. WeChat and WhatsApp check their own transport limits.
const (
	fileMaxBytes        = int64(20 << 20)
	discordFileMaxBytes = int64(10 << 20)
)

// File sends call each channel's upload directly instead of going through the bus, which carries
// text envelopes only. The decision's text is the caption: attached to the file when the channel
// takes one that long, otherwise sent after the file. A caption that fails after the file went out
// is a contacts.PartialDeliveryError.

func (s *RoutingSender) sendTelegramFile(ctx context.Context, target any, decision contacts.ShareDecision) (bool, bool, error) {
	token := strings.TrimSpace(s.telegramBotToken)
	if token == "" {
		return false, false, fmt.Errorf("telegram sender is not configured")
	}
	file, caption, err := prepareFileSend(decision, fileMaxBytes)
	if err != nil {
		return false, false, err
	}
	upload := telegramapi.Upload{
		FilePath:         file.Path,
		Filename:         file.Filename,
		Method:           "sendDocument",
		FormField:        "document",
		FallbackFilename: "file",
	}
	if username, ok, err := parseTelegramUsernameTarget(target); err != nil {
		return false, false, err
	} else if ok {
		upload.ChatID = username
	} else {
		resolved, err := normalizeTelegramSendTarget(target)
		if err != nil {
			return false, false, err
		}
		upload.ChatID = strconv.FormatInt(resolved.ChatID, 10)
		upload.MessageThreadID = resolved.MessageThreadID
	}
	attach := telegramapi.CaptionFits(caption)
	if attach {
		upload.Caption = caption
	}
	if err := telegramapi.SendFile(ctx, s.telegramClient, s.telegramBaseURL, token, upload); err != nil {
		return false, false, err
	}
	if caption != "" && !attach {
		if err := s.sendTelegramTarget(ctx, target, caption, telegrambus.SendTextOptions{}); err != nil {
			return true, false, &contacts.PartialDeliveryError{Err: err}
		}
	}
	return true, false, nil
}

func (s *RoutingSender) sendSlackFile(ctx context.Context, target slackbus.DeliveryTarget, decision contacts.ShareDecision) (bool, bool, error) {
	if s.slackPoster == nil {
		return false, false, fmt.Errorf("slack sender is not configured")
	}
	file, caption, err := prepareFileSend(decision, fileMaxBytes)
	if err != nil {
		return false, false, err
	}
	resolved, err := normalizeSlackSendTarget(target)
	if err != nil {
		return false, false, err
	}
	if err := s.slackPoster.UploadFile(ctx, resolved.ChannelID, "", file.Path, file.Filename, "", caption); err != nil {
		return false, false, err
	}
	return true, false, nil
}

func (s *RoutingSender) sendLarkFile(ctx context.Context, target larkSendTarget, decision contacts.ShareDecision) (bool, bool, error) {
	file, caption, err := prepareFileSend(decision, fileMaxBytes)
	if err != nil {
		return false, false, err
	}
	resolved, err := normalizeLarkSendTarget(target)
	if err != nil {
		return false, false, err
	}
	fileKey, err := s.lark.UploadFile(ctx, file.Path, file.Filename, "stream", 0)
	if err != nil {
		return false, false, err
	}
	if err := s.lark.SendMessage(ctx, resolved.ReceiveIDType, resolved.ReceiveID, "file", map[string]string{"file_key": fileKey}); err != nil {
		return false, false, err
	}
	if caption != "" {
		if err := s.lark.SendMessage(ctx, resolved.ReceiveIDType, resolved.ReceiveID, "text", map[string]string{"text": caption}); err != nil {
			return true, false, &contacts.PartialDeliveryError{Err: err}
		}
	}
	return true, false, nil
}

func (s *RoutingSender) sendDiscordFile(ctx context.Context, target discordSendTarget, decision contacts.ShareDecision) (bool, bool, error) {
	if s.discordInitErr != nil {
		return false, false, s.discordInitErr
	}
	file, caption, err := prepareFileSend(decision, discordFileMaxBytes)
	if err != nil {
		return false, false, err
	}
	channelID, err := s.discordChannelID(ctx, target)
	if err != nil {
		return false, false, err
	}
	data, err := os.ReadFile(file.Path)
	if err != nil {
		return false, false, err
	}
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(file.Filename)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	attach := utf8.RuneCountInString(caption) <= discordapi.MaxMessageLength
	msg := discordapi.MessageCreate{
		AllowedMentions: discordapi.NoMentions(),
		Files:           []discordapi.File{{Name: file.Filename, ContentType: contentType, Data: data}},
	}
	if attach {
		msg.Content = caption
	}
	if _, err := s.discordClient.CreateMessage(ctx, channelID, msg); err != nil {
		return false, false, err
	}
	if caption != "" && !attach {
		if err := s.sendDiscordTarget(ctx, channelID, caption, discordbus.SendTextOptions{}); err != nil {
			return true, false, &contacts.PartialDeliveryError{Err: err}
		}
	}
	return true, false, nil
}

func (s *RoutingSender) sendMixinFile(ctx context.Context, target mixinSendTarget, decision contacts.ShareDecision) (bool, bool, error) {
	if err := s.ensureMixinClient(); err != nil {
		return false, false, err
	}
	idempotencyKey := strings.TrimSpace(decision.IdempotencyKey)
	if idempotencyKey == "" {
		return false, false, fmt.Errorf("idempotency_key is required")
	}
	file, caption, err := prepareFileSend(decision, fileMaxBytes)
	if err != nil {
		return false, false, err
	}
	conversationID, err := s.mixinConversationID(ctx, target)
	if err != nil {
		return false, false, err
	}
	f, err := os.Open(file.Path)
	if err != nil {
		return false, false, err
	}
	defer f.Close()
	mimeType, err := fileMIMEType(f, file.Filename)
	if err != nil {
		return false, false, err
	}
	attachment, err := s.mixinClient.CreateAttachment(ctx)
	if err != nil {
		return false, false, err
	}
	if err := s.mixinClient.UploadAttachment(ctx, attachment, mimeType, file.Size, f); err != nil {
		return false, false, err
	}
	payload, err := json.Marshal(map[string]any{
		"attachment_id": strings.TrimSpace(attachment.AttachmentID),
		"mime_type":     mimeType,
		"size":          file.Size,
		"name":          file.Filename,
	})
	if err != nil {
		return false, false, err
	}
	// The same key always gives the same message ID, so Mixin drops a repeated message.
	messageID := uuid.NewSHA1(uuid.NameSpaceOID, []byte(idempotencyKey))
	s.mixinMessages.InvalidateConversation(conversationID)
	if err := s.mixinMessages.SendMessages(ctx, []mixinapi.MessageRequest{{
		ConversationID: conversationID,
		MessageID:      messageID.String(),
		Category:       mixinapi.MessageCategoryEncryptedData,
		DataBase64:     base64.RawURLEncoding.EncodeToString(payload),
	}}); err != nil {
		return false, false, err
	}
	if caption != "" {
		if err := s.sendMixinTarget(ctx, mixinbus.DeliveryTarget{ConversationID: conversationID}, caption, mixinbus.SendTextOptions{
			MessageID: uuid.NewSHA1(messageID, []byte("caption")).String(),
		}); err != nil {
			return true, false, &contacts.PartialDeliveryError{Err: err}
		}
	}
	return true, false, nil
}

// sendAccountDMFile sends through the channel's running runtime, whose transport applies its own
// size limit and caption handling.
func (s *RoutingSender) sendAccountDMFile(ctx context.Context, channel, peerID string, decision contacts.ShareDecision) (bool, bool, error) {
	file, caption, err := prepareFileSend(decision, fileMaxBytes)
	if err != nil {
		return false, false, err
	}
	if err := livesend.SendFile(ctx, channel, peerID, file.Path, file.Filename, caption); err != nil {
		return false, false, err
	}
	return true, false, nil
}

// prepareFileSend checks the decision's file again just before the upload, since it may have
// changed or gone after the tool checked it, and returns the caption.
func prepareFileSend(decision contacts.ShareDecision, maxBytes int64) (*contacts.ShareFile, string, error) {
	file := decision.File
	if file == nil || strings.TrimSpace(file.Path) == "" {
		return nil, "", fmt.Errorf("file path is required")
	}
	resolved, err := filepath.EvalSymlinks(file.Path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, "", fmt.Errorf("file no longer exists: %s", file.Path)
		}
		return nil, "", err
	}
	if resolved != file.Path {
		return nil, "", fmt.Errorf("file path changed after it was checked: %s", file.Path)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, "", err
	}
	if !info.Mode().IsRegular() {
		return nil, "", fmt.Errorf("path is not a regular file: %s", file.Path)
	}
	if info.Size() != file.Size {
		return nil, "", fmt.Errorf("file changed after it was checked: %s", file.Path)
	}
	if info.Size() > maxBytes {
		return nil, "", fmt.Errorf("file too large for this channel (>%d bytes): %s", maxBytes, file.Path)
	}
	caption, err := decodeFileCaption(decision.PayloadBase64)
	if err != nil {
		return nil, "", err
	}
	return file, caption, nil
}

// decodeFileCaption reads the optional caption from a file decision's envelope.
func decodeFileCaption(payloadBase64 string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(payloadBase64))
	if err != nil {
		return "", fmt.Errorf("decode payload_base64: %w", err)
	}
	var envelope struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", fmt.Errorf("decode message envelope: %w", err)
	}
	return strings.TrimSpace(envelope.Text), nil
}

func fileMIMEType(f *os.File, filename string) (string, error) {
	if byExtension := mime.TypeByExtension(strings.ToLower(filepath.Ext(filename))); byExtension != "" {
		if parsed, _, err := mime.ParseMediaType(byExtension); err == nil {
			return parsed, nil
		}
	}
	head := make([]byte, 512)
	n, err := f.Read(head)
	if err != nil && err != io.EOF {
		return "", err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return http.DetectContentType(head[:n]), nil
}

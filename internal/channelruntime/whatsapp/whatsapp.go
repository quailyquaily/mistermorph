// Package whatsapp runs Morph as a WhatsApp agent over the WhatsApp Agent Platform v1: a private
// chat with the agent's creator, polled over HTTP. See
// docs/feat/feat_20261001_wechat_whatsapp_channels_research.md.
package whatsapp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/runtimelock"
	"github.com/quailyquaily/mistermorph/internal/whatsappapi"
)

// Connection states shown in the overview.
const (
	StatusConnecting   = "connecting"
	StatusOnline       = "online"
	StatusDisconnected = "disconnected"
	StatusReauth       = "reauth_needed"
)

const (
	pollLimit    = 100
	pollTimeout  = whatsappapi.MaxPollTimeout
	maxBackoff   = time.Minute
	sendAttempts = 3
	// replayWindow is how far back the history read at start is acted on; older messages only
	// advance the offset. It matches how long Telegram keeps unconfirmed updates, so both channels
	// behave the same after a restart.
	replayWindow = 24 * time.Hour
)

type RunOptions struct {
	accountdm.Options
	APIToken string
	// OnStatusChange, if set, hears each connection status change (connecting, online,
	// disconnected, reauth_needed).
	OnStatusChange func(status string)
	// RuntimeLabel names this process in the poller lock ("morph whatsapp", "console").
	RuntimeLabel string

	client *whatsappapi.Client
	now    func() time.Time
}

// Run polls the agent's updates until ctx ends. Only one process may poll an agent at a time.
func Run(ctx context.Context, d accountdm.Dependencies, opts RunOptions) error {
	token := strings.TrimSpace(opts.APIToken)
	client := opts.client
	if client == nil {
		if token == "" {
			return fmt.Errorf("missing whatsapp.api_token: copy the agent's API key from WhatsApp (Chat info > API key), or set MISTER_MORPH_WHATSAPP_API_TOKEN")
		}
		var err error
		client, err = whatsappapi.NewClient(token, whatsappapi.Options{})
		if err != nil {
			return err
		}
	}
	// The token is opaque and names no agent, so the lock is keyed by its hash.
	sum := sha256.Sum256([]byte(token))
	lock, err := runtimelock.Acquire(d.RuntimePaths.StateDir, "whatsapp-"+hex.EncodeToString(sum[:6]), firstNonEmpty(opts.RuntimeLabel, "morph whatsapp"))
	if err != nil {
		return err
	}
	defer lock.Release()
	logger, err := d.Logger()
	if err != nil {
		return err
	}
	if logger == nil {
		logger = slog.Default()
	}
	now := opts.now
	if now == nil {
		now = time.Now
	}
	transport := newTransport(client, logger.With("channel", "whatsapp"), now)
	transport.onStatus = opts.OnStatusChange
	engineOpts := opts.Options
	engineOpts.Channel = busruntime.ChannelWhatsApp
	engineOpts.Transport = transport
	engineOpts.PromptBlocks = func(spec *agent.PromptSpec) { promptprofile.AppendWhatsAppRuntimeBlocks(spec) }
	return accountdm.Run(ctx, d, engineOpts)
}

type transport struct {
	client *whatsappapi.Client
	logger *slog.Logger
	now    func() time.Time

	status   atomic.Value // string
	onStatus func(string)
	agent    atomic.Value // string
	names    sync.Map     // user id -> profile name, gathered across polls
}

func newTransport(client *whatsappapi.Client, logger *slog.Logger, now func() time.Time) *transport {
	t := &transport{client: client, logger: logger, now: now}
	t.status.Store(StatusConnecting)
	t.agent.Store("")
	return t
}

func (t *transport) setStatus(status string) {
	if previous, _ := t.status.Swap(status).(string); previous != status {
		t.logger.Info("connection_status", "status", status)
		if t.onStatus != nil {
			t.onStatus(status)
		}
	}
}

func (t *transport) Overview() map[string]any {
	status, _ := t.status.Load().(string)
	agentID, _ := t.agent.Load().(string)
	connected := status == StatusOnline
	return map[string]any{
		"configured": true, "running": "whatsapp", "connected": connected, "status": status, "account": agentID,
		"whatsapp_configured": true, "whatsapp_running": true, "whatsapp_connected": connected, "whatsapp_status": status,
	}
}

func (t *transport) MaxTextLength() int { return whatsappapi.MaxTextLength }

// Typing is not available: the platform shows typing only together with a read receipt, and v1
// sends no read receipts, since a message marked read may no longer be replayed after a crash.
func (t *transport) Typing(context.Context, string, string) func() { return func() {} }

// Run long-polls updates. The offset lives only in memory: each start reads from offset 0, acts
// only on messages from the last day, and the bus inbox drops messages already handled.
func (t *transport) Run(ctx context.Context, deliver func(context.Context, accountdm.Inbound) error) error {
	startedAt := t.now()
	var offset int64
	backoff := time.Second
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		updates, err := t.client.GetUpdates(ctx, offset, pollLimit, pollTimeout)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, whatsappapi.ErrPollReplaced) {
				t.setStatus(StatusDisconnected)
				return fmt.Errorf("whatsapp: %w", err)
			}
			if whatsappapi.IsUnauthorized(err) {
				t.setStatus(StatusReauth)
				t.logger.Error("token_rejected", "hint", "copy a new API key from the agent's Chat info in WhatsApp", "error", err.Error())
				<-ctx.Done()
				return ctx.Err()
			}
			t.setStatus(StatusDisconnected)
			t.logger.Warn("poll_failed", "retry_in", backoff.String(), "error", err.Error())
			if err := sleep(ctx, backoff); err != nil {
				return err
			}
			backoff = min(backoff*2, maxBackoff)
			continue
		}
		backoff = time.Second
		t.setStatus(StatusOnline)
		if updates.AgentID != "" {
			t.agent.Store(updates.AgentID)
		}
		for _, contact := range updates.Contacts {
			if id := whatsappapi.UserID(contact.WaID); id != "" && contact.Name != "" {
				t.names.Store(id, contact.Name)
			}
		}
		agentID, _ := t.agent.Load().(string)
		for _, msg := range updates.Messages {
			if sentAt := msg.SentAt(); !sentAt.IsZero() && startedAt.Sub(sentAt) > replayWindow {
				continue
			}
			t.handle(ctx, agentID, msg, deliver)
		}
		offset = updates.NextOffset
	}
}

func (t *transport) handle(ctx context.Context, agentID string, msg whatsappapi.Message, deliver func(context.Context, accountdm.Inbound) error) {
	userID := whatsappapi.UserID(msg.From)
	if userID == "" || agentID == "" || strings.TrimSpace(msg.ID) == "" {
		t.logger.Debug("message_skipped", "from", msg.From, "message_id", msg.ID)
		return
	}
	name, _ := t.names.Load(userID)
	display, _ := name.(string)
	replyTo := ""
	if msg.Context != nil {
		replyTo = strings.TrimSpace(msg.Context.ID)
	}
	in := accountdm.Inbound{AccountID: agentID, PeerID: userID, MessageID: msg.ID, SentAt: msg.SentAt(), DisplayName: display, ReplyToMessageID: replyTo}
	switch msg.Type {
	case "text":
		if msg.Text == nil || strings.TrimSpace(msg.Text.Body) == "" {
			return
		}
		in.Text = msg.Text.Body
	case "reaction":
		// A reaction only records that the user reacted; it is never an approval decision.
		return
	default:
		media, kind := msg.MediaObject()
		if media == nil || strings.TrimSpace(media.ID) == "" {
			in.Unsupported = true
			break
		}
		in.Text = media.Caption
		in.Media = []accountdm.Media{t.inboundMedia(kind, *media)}
	}
	if err := deliver(ctx, in); err != nil {
		t.logger.Warn("deliver_failed", "message_id", msg.ID, "error", err.Error())
	}
}

// inboundMedia downloads one media object when the engine asks for it.
func (t *transport) inboundMedia(kind string, media whatsappapi.Media) accountdm.Media {
	out := accountdm.Media{Kind: kind, Name: media.Filename, MIMEType: media.MimeType}
	switch kind {
	case "document":
		out.Kind = "file"
	case "sticker":
		// A sticker is a WebP image.
		out.Kind = "image"
	case "audio":
		if media.Voice {
			out.Name = "voice" + extensionFor(media.MimeType)
		}
	}
	out.Fetch = func(ctx context.Context) ([]byte, string, error) {
		data, info, err := t.client.DownloadMedia(ctx, media.ID, whatsappapi.MaxMediaBytes)
		if err != nil {
			return nil, "", err
		}
		if media.SHA256 != "" && !whatsappapi.SHA256Matches(data, media.SHA256) {
			return nil, "", fmt.Errorf("the file does not match its digest")
		}
		return data, firstNonEmpty(info.MimeType, media.MimeType), nil
	}
	return out
}

func extensionFor(mimeType string) string {
	if strings.HasPrefix(strings.ToLower(mimeType), "audio/ogg") {
		return ".ogg"
	}
	return ""
}

// SendFile uploads a file and sends it: an image, video, audio or document by its MIME type. The
// message goes as a caption where the type takes one, else as a text message first.
func (t *transport) SendFile(ctx context.Context, _ string, peerID string, file accountdm.OutboundFile) error {
	data, err := os.ReadFile(file.Path)
	if err != nil {
		return err
	}
	messageType := whatsappapi.MediaType(file.MIMEType)
	if int64(len(data)) > whatsappapi.MaxBytesFor(messageType) && messageType != "document" {
		// Too big for an image: send it as a document, which allows 16 MB.
		messageType = "document"
	}
	caption := strings.TrimSpace(file.Caption)
	if caption != "" && (messageType == "audio" || len([]rune(caption)) > whatsappapi.MaxCaptionLength) {
		if err := t.SendText(ctx, "", peerID, caption, ""); err != nil {
			return err
		}
		caption = ""
	}
	mimeType := file.MIMEType
	if messageType == "document" && whatsappapi.MediaType(mimeType) != "document" {
		mimeType = "application/octet-stream"
	}
	mediaID, err := t.client.UploadMedia(ctx, file.Name, mimeType, data)
	if err != nil {
		if whatsappapi.IsUnauthorized(err) {
			t.setStatus(StatusReauth)
		}
		return err
	}
	return t.retrySend(ctx, func() error {
		_, err := t.client.SendMedia(ctx, peerID, messageType, mediaID, caption, file.Name)
		return err
	})
}

func (t *transport) MaxFileBytes() int64 { return whatsappapi.MaxMediaBytes }

func (t *transport) AccountID() string {
	agent, _ := t.agent.Load().(string)
	return agent
}

// SendText retries only sends the server says it did not take (429, or 503 with code 131016). An
// unknown outcome is returned as is: retrying it could send the message twice.
func (t *transport) SendText(ctx context.Context, _ string, peerID, text, replyTo string) error {
	return t.retrySend(ctx, func() error {
		_, err := t.client.SendText(ctx, peerID, text, replyTo)
		return err
	})
}

func (t *transport) retrySend(ctx context.Context, send func() error) error {
	delay := 2 * time.Second
	for attempt := 1; ; attempt++ {
		err := send()
		if err == nil || !whatsappapi.IsRetryable(err) || attempt == sendAttempts {
			if whatsappapi.IsUnauthorized(err) {
				t.setStatus(StatusReauth)
			}
			return err
		}
		t.logger.Warn("send_retry", "attempt", attempt, "retry_in", delay.String(), "error", err.Error())
		if err := sleep(ctx, delay); err != nil {
			return err
		}
		delay *= 2
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
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

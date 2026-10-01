// Package wechat runs Morph as a WeChat bot over Tencent's iLink protocol: private chats only,
// polled over HTTP. See docs/feat/feat_20261001_wechat_whatsapp_channels_research.md.
package wechat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	"github.com/quailyquaily/mistermorph/internal/wechatapi"
)

// Connection states shown in the overview.
const (
	StatusConnecting   = "connecting"
	StatusOnline       = "online"
	StatusDisconnected = "disconnected"
	StatusReauth       = "reauth_needed"
)

const (
	// maxInboundBytes caps a file a user sends; maxOutboundBytes one the agent sends.
	maxInboundBytes   = int64(50 << 20)
	maxOutboundBytes  = int64(50 << 20)
	maxTextLength     = 4000
	typingRenew       = 10 * time.Second
	retryDelay        = 2 * time.Second
	backoffDelay      = 30 * time.Second
	failuresToBackoff = 3
)

type RunOptions struct {
	accountdm.Options
	BotToken string
	BotID    string
	BaseURL  string
	// OnStatusChange, if set, hears each connection status change (connecting, online,
	// disconnected, reauth_needed).
	OnStatusChange func(status string)
	// RuntimeLabel names this process in the poller lock ("morph wechat", "console").
	RuntimeLabel string

	client *wechatapi.Client
}

// Run polls WeChat until ctx ends. Only one process may poll a bot at a time.
func Run(ctx context.Context, d accountdm.Dependencies, opts RunOptions) error {
	token := strings.TrimSpace(opts.BotToken)
	if token == "" && opts.client == nil {
		return fmt.Errorf("missing wechat.bot_token: run `morph wechat login` first, or set MISTER_MORPH_WECHAT_BOT_TOKEN")
	}
	client := opts.client
	if client == nil {
		var err error
		client, err = wechatapi.NewClient(token, wechatapi.Options{BaseURL: opts.BaseURL, BotAgent: botAgent()})
		if err != nil {
			return err
		}
	}
	account := AccountID(opts.BotID, token)
	lock, err := runtimelock.Acquire(d.RuntimePaths.StateDir, "wechat-"+account, firstNonEmpty(opts.RuntimeLabel, "morph wechat"))
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
	transport := newTransport(client, account, logger.With("channel", "wechat"))
	transport.onStatus = opts.OnStatusChange
	engineOpts := opts.Options
	engineOpts.Channel = busruntime.ChannelWeChat
	engineOpts.Transport = transport
	engineOpts.PromptBlocks = func(spec *agent.PromptSpec) { promptprofile.AppendWeChatRuntimeBlocks(spec) }
	return accountdm.Run(ctx, d, engineOpts)
}

// AccountID is the bound bot's ID; a token without a recorded bot ID is identified by its hash.
func AccountID(botID, token string) string {
	if id := strings.TrimSpace(botID); id != "" && !strings.ContainsAny(id, ": \t\r\n") {
		return id
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return "token-" + hex.EncodeToString(sum[:6])
}

func botAgent() string { return "Mistermorph" }

type transport struct {
	client  *wechatapi.Client
	account string
	logger  *slog.Logger

	status   atomic.Value // string
	onStatus func(string)
	// contexts holds each user's latest context_token, which a reply must carry. It lives only in
	// memory: after a restart, the user's next message brings a new one.
	contexts sync.Map
	tickets  sync.Map
}

func newTransport(client *wechatapi.Client, account string, logger *slog.Logger) *transport {
	t := &transport{client: client, account: account, logger: logger}
	t.status.Store(StatusConnecting)
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
	connected := status == StatusOnline
	return map[string]any{
		"configured": true, "running": "wechat", "connected": connected, "status": status, "account": t.account,
		"wechat_configured": true, "wechat_running": true, "wechat_connected": connected, "wechat_status": status,
	}
}

func (t *transport) MaxTextLength() int { return maxTextLength }

// Run long-polls getupdates. The cursor lives only in memory, as other channels' offsets do: after
// a restart polling starts again and the bus inbox drops messages it has already seen.
func (t *transport) Run(ctx context.Context, deliver func(context.Context, accountdm.Inbound) error) error {
	if err := t.client.NotifyStart(ctx); err != nil {
		t.logger.Warn("notify_start_failed", "error", err.Error())
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = t.client.NotifyStop(stopCtx)
	}()
	cursor := ""
	var pollTimeout time.Duration
	failures := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		updates, err := t.client.GetUpdates(ctx, cursor, pollTimeout)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if wechatapi.IsSessionExpired(err) {
				// The bot's session ended: polling again cannot help until the user scans a new code.
				t.setStatus(StatusReauth)
				t.logger.Error("session_expired", "hint", "run `morph wechat login` (or reconnect in Console) to authorize again", "error", err.Error())
				<-ctx.Done()
				return ctx.Err()
			}
			t.setStatus(StatusDisconnected)
			failures++
			delay := retryDelay
			if failures >= failuresToBackoff {
				delay, failures = backoffDelay, 0
			}
			t.logger.Warn("getupdates_failed", "retry_in", delay.String(), "error", err.Error())
			if err := sleep(ctx, delay); err != nil {
				return err
			}
			continue
		}
		failures = 0
		t.setStatus(StatusOnline)
		if updates.Buf != "" {
			cursor = updates.Buf
		}
		if updates.LongPollTimeout > 0 {
			pollTimeout = updates.LongPollTimeout
		}
		for _, msg := range updates.Messages {
			t.handle(ctx, msg, deliver)
		}
	}
}

func (t *transport) handle(ctx context.Context, msg wechatapi.Message, deliver func(context.Context, accountdm.Inbound) error) {
	from := strings.TrimSpace(msg.FromUserID)
	if msg.MessageType != wechatapi.MessageTypeUser || from == "" || strings.ContainsAny(from, ": \t\r\n") {
		return
	}
	if strings.TrimSpace(msg.GroupID) != "" {
		t.logger.Debug("group_message_ignored", "message_id", msg.ID())
		return
	}
	if token := strings.TrimSpace(msg.ContextToken); token != "" {
		t.contexts.Store(from, token)
	}
	text := msg.Text()
	if quoted := msg.QuotedText(); quoted != "" && text != "" {
		text = "> " + strings.ReplaceAll(quoted, "\n", "\n> ") + "\n\n" + text
	}
	id := msg.ID()
	if id == "" {
		t.logger.Warn("message_without_id", "from", from)
		return
	}
	in := accountdm.Inbound{AccountID: t.account, PeerID: from, MessageID: id, SentAt: msg.SentAt(), Text: text}
	for _, ref := range msg.Media() {
		in.Media = append(in.Media, t.inboundMedia(ref))
	}
	if strings.TrimSpace(text) == "" && len(in.Media) == 0 {
		if !msg.HasMedia() {
			return
		}
		in.Unsupported = true
	}
	if err := deliver(ctx, in); err != nil {
		t.logger.Warn("deliver_failed", "message_id", id, "error", err.Error())
	}
}

// inboundMedia downloads and decrypts one media item when the engine asks for it.
func (t *transport) inboundMedia(ref wechatapi.MediaRef) accountdm.Media {
	media := accountdm.Media{Kind: string(ref.Kind), Name: ref.Name}
	switch ref.Kind {
	case wechatapi.MediaVoice:
		// A voice message without a transcript is SILK audio, which few tools read.
		media.Kind, media.MIMEType = "audio", "audio/silk"
	case wechatapi.MediaVideo:
		media.MIMEType = "video/mp4"
	}
	media.Fetch = func(ctx context.Context) ([]byte, string, error) {
		if ref.Size > maxInboundBytes {
			return nil, "", fmt.Errorf("the file is %d MB, over the %d MB limit", ref.Size>>20, maxInboundBytes>>20)
		}
		data, err := t.client.DownloadMedia(ctx, ref)
		if err != nil {
			return nil, "", err
		}
		if int64(len(data)) > maxInboundBytes {
			return nil, "", fmt.Errorf("the file is over the %d MB limit", maxInboundBytes>>20)
		}
		return data, media.MIMEType, nil
	}
	return media
}

// SendFile uploads a file to the CDN and sends it as an image, video or file, after its caption.
func (t *transport) SendFile(ctx context.Context, _ string, peerID string, file accountdm.OutboundFile) error {
	token, _ := t.contexts.Load(peerID)
	contextToken, _ := token.(string)
	if contextToken == "" {
		return fmt.Errorf("%w for %s; WeChat replies need a recent message from the user", wechatapi.ErrNoContext, peerID)
	}
	data, err := os.ReadFile(file.Path)
	if err != nil {
		return err
	}
	if int64(len(data)) > maxOutboundBytes {
		return fmt.Errorf("the file is over the %d MB limit", maxOutboundBytes>>20)
	}
	kind := wechatapi.MediaFile
	switch mimeType := strings.ToLower(file.MIMEType); {
	case strings.HasPrefix(mimeType, "image/") && mimeType != "image/svg+xml":
		kind = wechatapi.MediaImage
	case strings.HasPrefix(mimeType, "video/"):
		kind = wechatapi.MediaVideo
	}
	if caption := strings.TrimSpace(file.Caption); caption != "" {
		if err := t.SendText(ctx, t.account, peerID, caption, ""); err != nil {
			return err
		}
	}
	uploaded, err := t.client.UploadMedia(ctx, peerID, kind, data)
	if err == nil {
		_, err = t.client.SendMedia(ctx, peerID, contextToken, kind, file.Name, uploaded)
	}
	if wechatapi.IsSessionExpired(err) {
		t.setStatus(StatusReauth)
	}
	return err
}

func (t *transport) MaxFileBytes() int64 { return maxOutboundBytes }

func (t *transport) AccountID() string { return t.account }

func (t *transport) SendText(ctx context.Context, _ string, peerID, text, _ string) error {
	token, _ := t.contexts.Load(peerID)
	contextToken, _ := token.(string)
	_, err := t.client.SendText(ctx, peerID, contextToken, text)
	if wechatapi.IsSessionExpired(err) {
		t.setStatus(StatusReauth)
	}
	return err
}

// Typing shows "typing" until stop, renewing it; a failure only skips the indicator.
func (t *transport) Typing(ctx context.Context, _ string, peerID string) func() {
	typingCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticket := t.ticket(typingCtx, peerID)
		if ticket == "" {
			return
		}
		ticker := time.NewTicker(typingRenew)
		defer ticker.Stop()
		for {
			if err := t.client.SendTyping(typingCtx, peerID, ticket, true); err != nil && typingCtx.Err() == nil {
				t.logger.Debug("typing_failed", "error", err.Error())
				return
			}
			select {
			case <-typingCtx.Done():
				clearCtx, clearCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				_ = t.client.SendTyping(clearCtx, peerID, ticket, false)
				clearCancel()
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

func (t *transport) ticket(ctx context.Context, peerID string) string {
	if cached, ok := t.tickets.Load(peerID); ok {
		return cached.(string)
	}
	token, _ := t.contexts.Load(peerID)
	contextToken, _ := token.(string)
	ticket, err := t.client.TypingTicket(ctx, peerID, contextToken)
	if err != nil || ticket == "" {
		return ""
	}
	t.tickets.Store(peerID, ticket)
	return ticket
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

package core

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/grouptrigger"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/llm"
)

// defaultLightweightPrecheckTimeout bounds the check when the decision profile sets no
// request_timeout; the message waits on it before any reply.
const defaultLightweightPrecheckTimeout = 30 * time.Second

// PrecheckResult is what a lightweight pre-check decided for the main loop.
type PrecheckResult int

const (
	// PrecheckSkipped: the check did not run or failed; run the main loop as before.
	PrecheckSkipped PrecheckResult = iota
	// PrecheckText: the message needs text; run the main loop without the lightweight rules.
	PrecheckText
	// PrecheckHandled: the emoji was delivered; do not run the main loop.
	PrecheckHandled
)

// LightweightPrecheckRequest is one message addressed to the agent (a private message, or a group
// message that explicitly mentions it) that may need only an emoji.
type LightweightPrecheckRequest struct {
	Scene          string
	PersonaDir     string
	CurrentMessage any
	History        []chathistory.ChatHistoryItem
	// Emojis are the choices the channel can deliver. Leave empty to offer
	// grouptrigger.DefaultLightweightEmojis, sent as a message.
	Emojis []string
	// Deliver sends the chosen emoji, as a native reaction or as a message.
	Deliver func(ctx context.Context, emoji string) error
	Logger  *slog.Logger
}

// RunLightweightPrecheck asks the bundle's decision route whether the message needs only an emoji,
// and delivers it when so. It does nothing unless the decision route has its own profile. Any
// failure returns PrecheckSkipped, so the main loop runs as it would without the check. On
// PrecheckHandled it also returns the delivered emoji.
func RunLightweightPrecheck(ctx context.Context, bundle *ChannelRuntimeBundle, req LightweightPrecheckRequest) (PrecheckResult, string) {
	if bundle == nil || !bundle.LightweightPrecheck || bundle.AddressingClient == nil || req.Deliver == nil {
		return PrecheckSkipped, ""
	}
	if ctx == nil {
		ctx = context.Background()
	}
	logger := req.Logger
	if logger == nil {
		logger = slog.Default()
	}
	emojis := req.Emojis
	if len(emojis) == 0 {
		emojis = grouptrigger.DefaultLightweightEmojis
	}
	timeout := bundle.AddressingRoute.ClientConfig.RequestTimeout
	if timeout <= 0 {
		timeout = defaultLightweightPrecheckTimeout
	}
	checkCtx, cancel := context.WithTimeout(ctx, timeout)
	started := time.Now()
	emoji, err := grouptrigger.DecideLightweight(checkCtx, grouptrigger.LightweightOptions{
		Client:          bundle.AddressingClient,
		Model:           bundle.AddressingModel,
		Scene:           req.Scene,
		PersonaIdentity: PersonaIdentity(req.PersonaDir),
		CurrentMessage:  req.CurrentMessage,
		History:         req.History,
		Emojis:          emojis,
	})
	cancel()
	elapsed := time.Since(started)
	if err != nil {
		level := slog.LevelWarn
		if errors.Is(err, llm.ErrEvaluateUnsupported) {
			level = slog.LevelDebug
		}
		logger.Log(ctx, level, "lightweight_precheck_failed", "scene", req.Scene, "duration", elapsed, "error", err.Error())
		return PrecheckSkipped, ""
	}
	if emoji == "" {
		logger.Info("lightweight_precheck", "scene", req.Scene, "result", "text", "duration", elapsed)
		return PrecheckText, ""
	}
	if err := req.Deliver(ctx, emoji); err != nil {
		logger.Warn("lightweight_precheck_deliver_failed", "scene", req.Scene, "emoji", emoji, "error", err.Error())
		return PrecheckSkipped, ""
	}
	logger.Info("lightweight_precheck", "scene", req.Scene, "result", "emoji", "emoji", emoji, "duration", elapsed)
	return PrecheckHandled, emoji
}

// LightweightPrecheckApplies reports whether a message may be pre-checked: it carries text the
// check can read, has no attachments the check cannot see, and is not a command.
func LightweightPrecheckApplies(text string, hasAttachments bool) bool {
	text = strings.TrimSpace(text)
	return text != "" && !hasAttachments && !strings.HasPrefix(text, "/")
}

var silentPersonaLogger = slog.New(slog.NewTextHandler(io.Discard, nil))

// PersonaIdentity loads the persona identity text used by decision-route prompts.
func PersonaIdentity(personaDir string) string {
	spec := agent.PromptSpec{}
	promptprofile.ApplyPersonaIdentity(&spec, silentPersonaLogger, personaDir)
	return strings.TrimSpace(spec.Identity)
}

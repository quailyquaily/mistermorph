package telegram

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

// API is the minimal Telegram transport surface needed by telegram tools.
type API interface {
	SendDocument(ctx context.Context, chatID int64, filePath string, filename string, caption string) error
	SendVoice(ctx context.Context, chatID int64, filePath string, filename string, caption string) error
	SetEmojiReaction(ctx context.Context, chatID int64, messageID int64, emoji string, isBig *bool) error
}

type Reaction struct {
	ChatID    int64
	MessageID int64
	Emoji     string
	Source    string
}

type SendFileTool struct {
	api      API
	chatID   int64
	cacheDir string
	maxBytes int64
}

type SendVoiceTool struct {
	api        API
	defaultTo  int64
	cacheDir   string
	maxBytes   int64
	allowedIDs map[int64]bool
}

type ReactTool struct {
	api              API
	defaultChatID    int64
	defaultMessageID int64
	allowedIDs       map[int64]bool
	allowedEmojis    map[string]bool
	lastReaction     *Reaction
}

func NewSendFileTool(api API, chatID int64, cacheDir string, maxBytes int64) *SendFileTool {
	if maxBytes <= 0 {
		maxBytes = 20 * 1024 * 1024
	}
	return &SendFileTool{
		api:      api,
		chatID:   chatID,
		cacheDir: strings.TrimSpace(cacheDir),
		maxBytes: maxBytes,
	}
}

func (t *SendFileTool) Name() string { return "telegram_send_file" }

func (t *SendFileTool) Description() string {
	return "Sends a local file (from file_cache_dir) back to the current chat as a document. If you need more advanced behavior, describe it in text instead."
}

func (t *SendFileTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{
				"type":        "string",
				"description": "Path to a local file under file_cache_dir (absolute or relative to that directory).",
			},
			"filename": map[string]any{
				"type":        "string",
				"description": "Optional filename shown to the user (default: basename of path).",
			},
			"caption": map[string]any{
				"type":        "string",
				"description": "Optional caption text.",
			},
		},
		"required": []string{"path"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *SendFileTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.api == nil {
		return "", fmt.Errorf("telegram_send_file is disabled")
	}
	rawPath, _ := params["path"].(string)
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" {
		return "", fmt.Errorf("missing required param: path")
	}
	rawPath = pathutil.NormalizeFileCacheDirPath(rawPath)
	cacheDir := strings.TrimSpace(t.cacheDir)
	if cacheDir == "" {
		return "", fmt.Errorf("file cache dir is not configured")
	}

	p := rawPath
	if !filepath.IsAbs(p) {
		p = filepath.Join(cacheDir, p)
	}
	p = filepath.Clean(p)

	cacheAbs, err := filepath.Abs(cacheDir)
	if err != nil {
		return "", err
	}
	pathAbs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(cacheAbs, pathAbs)
	if err != nil {
		return "", err
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || rel == ".." {
		return "", fmt.Errorf("refusing to send file outside file_cache_dir: %s", pathAbs)
	}

	st, err := os.Stat(pathAbs)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", fmt.Errorf("path is a directory: %s", pathAbs)
	}
	if t.maxBytes > 0 && st.Size() > t.maxBytes {
		return "", fmt.Errorf("file too large to send (>%d bytes): %s", t.maxBytes, pathAbs)
	}

	filename, _ := params["filename"].(string)
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = filepath.Base(pathAbs)
	}
	filename = sanitizeFilename(filename)

	caption, _ := params["caption"].(string)
	caption = strings.TrimSpace(caption)

	if err := t.api.SendDocument(ctx, t.chatID, pathAbs, filename, caption); err != nil {
		return "", err
	}
	return fmt.Sprintf("sent file: %s", filename), nil
}

func NewSendVoiceTool(api API, defaultChatID int64, cacheDir string, maxBytes int64, allowedIDs map[int64]bool) *SendVoiceTool {
	if maxBytes <= 0 {
		maxBytes = 20 * 1024 * 1024
	}
	return &SendVoiceTool{
		api:        api,
		defaultTo:  defaultChatID,
		cacheDir:   strings.TrimSpace(cacheDir),
		maxBytes:   maxBytes,
		allowedIDs: allowedIDs,
	}
}

func (t *SendVoiceTool) Name() string { return "telegram_send_voice" }

func (t *SendVoiceTool) Description() string {
	return "Sends a Telegram voice message. Provide either a local .ogg/.opus file under file_cache_dir, or omit path and provide text to synthesize locally. Use chat_id when not running in an active chat context."
}

func (t *SendVoiceTool) ParameterSchema() string {
	s := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"chat_id": map[string]any{
				"type":        "integer",
				"description": "Target Telegram chat_id. Optional in interactive chat context; required for scheduled runs unless default chat_id is set.",
			},
			"path": map[string]any{
				"type":        "string",
				"description": "Path to a local voice file under file_cache_dir (absolute or relative to that directory). Recommended: .ogg with Opus audio. If omitted, the tool can synthesize a voice file from `text`.",
			},
			"text": map[string]any{
				"type":        "string",
				"description": "Text to synthesize into a voice message when `path` is omitted. If omitted, falls back to `caption`.",
			},
			"lang": map[string]any{
				"type":        "string",
				"description": "Optional language tag for TTS (BCP-47, e.g., en-US, zh-CN). If omitted, auto-detect.",
			},
			"filename": map[string]any{
				"type":        "string",
				"description": "Optional filename shown to the user (default: basename of path).",
			},
			"caption": map[string]any{
				"type":        "string",
				"description": "Optional caption text.",
			},
		},
		"required": []string{},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *SendVoiceTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.api == nil {
		return "", fmt.Errorf("telegram_send_voice is disabled")
	}

	chatID := t.defaultTo
	if v, ok := params["chat_id"]; ok {
		switch x := v.(type) {
		case int64:
			chatID = x
		case int:
			chatID = int64(x)
		case float64:
			chatID = int64(x)
		}
	}
	if chatID == 0 {
		return "", fmt.Errorf("missing required param: chat_id")
	}
	if len(t.allowedIDs) > 0 && !t.allowedIDs[chatID] {
		return "", fmt.Errorf("unauthorized chat_id: %d", chatID)
	}

	cacheDir := strings.TrimSpace(t.cacheDir)
	if cacheDir == "" {
		return "", fmt.Errorf("file cache dir is not configured")
	}

	cacheAbs, err := filepath.Abs(cacheDir)
	if err != nil {
		return "", err
	}
	caption, _ := params["caption"].(string)
	caption = strings.TrimSpace(caption)

	rawPath, _ := params["path"].(string)
	rawPath = strings.TrimSpace(rawPath)
	rawPath = pathutil.NormalizeFileCacheDirPath(rawPath)

	var pathAbs string
	if rawPath != "" {
		p := rawPath
		if !filepath.IsAbs(p) {
			p = filepath.Join(cacheDir, p)
		}
		p = filepath.Clean(p)

		pathAbs, err = filepath.Abs(p)
		if err != nil {
			return "", err
		}
		rel, err := filepath.Rel(cacheAbs, pathAbs)
		if err != nil {
			return "", err
		}
		if rel == "." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || rel == ".." {
			return "", fmt.Errorf("refusing to send file outside file_cache_dir: %s", pathAbs)
		}

		st, err := os.Stat(pathAbs)
		if err != nil {
			return "", err
		}
		if st.IsDir() {
			return "", fmt.Errorf("path is a directory: %s", pathAbs)
		}
		if t.maxBytes > 0 && st.Size() > t.maxBytes {
			return "", fmt.Errorf("file too large to send (>%d bytes): %s", t.maxBytes, pathAbs)
		}
	} else {
		text, _ := params["text"].(string)
		text = strings.TrimSpace(text)
		if text == "" {
			text = caption
		}
		lang, _ := params["lang"].(string)
		lang = strings.TrimSpace(lang)
		synthCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		pathAbs, err = synthesizeVoiceToOggOpusWithLang(synthCtx, cacheAbs, text, lang)
		if err != nil {
			return "", err
		}
	}

	filename, _ := params["filename"].(string)
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = filepath.Base(pathAbs)
	}
	filename = sanitizeFilename(filename)

	if err := t.api.SendVoice(ctx, chatID, pathAbs, filename, caption); err != nil {
		return "", err
	}
	return fmt.Sprintf("sent voice: %s", filename), nil
}

func NewReactTool(api API, defaultChatID int64, defaultMessageID int64, allowedIDs map[int64]bool, allowedEmojis map[string]bool) *ReactTool {
	emojiSet := make(map[string]bool, len(allowedEmojis))
	for emoji := range allowedEmojis {
		emoji = strings.TrimSpace(emoji)
		if emoji == "" {
			continue
		}
		emojiSet[emoji] = true
	}
	return &ReactTool{
		api:              api,
		defaultChatID:    defaultChatID,
		defaultMessageID: defaultMessageID,
		allowedIDs:       allowedIDs,
		allowedEmojis:    emojiSet,
	}
}

func (t *ReactTool) Name() string { return "telegram_react" }

func (t *ReactTool) Description() string {
	return "Adds an emoji reaction to a Telegram message. Use when a light confirmation is sufficient; do not send an extra text reply when reaction alone is enough."
}

func (t *ReactTool) ParameterSchema() string {
	s := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"chat_id": map[string]any{
				"type":        "integer",
				"description": "Target Telegram chat_id. Optional in active chat context; required when reacting outside the current chat.",
			},
			"message_id": map[string]any{
				"type":        "integer",
				"description": "Target Telegram message_id. Optional in active chat context; defaults to the triggering message.",
			},
			"emoji": map[string]any{
				"type":        "string",
				"description": "Emoji to react with.",
			},
			"is_big": map[string]any{
				"type":        "boolean",
				"description": "Optional big reaction flag.",
			},
		},
		"required": []string{"emoji"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *ReactTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.api == nil {
		return "", fmt.Errorf("telegram_react is disabled")
	}

	chatID := t.defaultChatID
	if v, ok := params["chat_id"]; ok {
		switch x := v.(type) {
		case int64:
			chatID = x
		case int:
			chatID = int64(x)
		case float64:
			chatID = int64(x)
		}
	}
	if chatID == 0 {
		return "", fmt.Errorf("missing required param: chat_id")
	}
	if len(t.allowedIDs) > 0 && !t.allowedIDs[chatID] {
		return "", fmt.Errorf("unauthorized chat_id: %d", chatID)
	}

	messageID := t.defaultMessageID
	if v, ok := params["message_id"]; ok {
		switch x := v.(type) {
		case int64:
			messageID = x
		case int:
			messageID = int64(x)
		case float64:
			messageID = int64(x)
		}
	}
	if messageID == 0 {
		return "", fmt.Errorf("missing required param: message_id")
	}

	emoji, _ := params["emoji"].(string)
	emoji = strings.TrimSpace(emoji)
	if emoji == "" {
		return "", fmt.Errorf("missing required param: emoji")
	}
	if t.allowedEmojis == nil {
		return "", fmt.Errorf("available reactions cache is not initialized")
	}
	if !t.allowedEmojis[emoji] {
		return "", fmt.Errorf("emoji is not available in current Telegram reactions list: %s", emoji)
	}

	var isBigPtr *bool
	if v, ok := params["is_big"]; ok {
		if b, ok := v.(bool); ok {
			isBig := b
			isBigPtr = &isBig
		}
	}

	if err := t.api.SetEmojiReaction(ctx, chatID, messageID, emoji, isBigPtr); err != nil {
		return "", err
	}

	t.lastReaction = &Reaction{
		ChatID:    chatID,
		MessageID: messageID,
		Emoji:     emoji,
		Source:    "tool",
	}
	return fmt.Sprintf("reacted with %s", emoji), nil
}

func (t *ReactTool) LastReaction() *Reaction {
	if t == nil {
		return nil
	}
	return t.lastReaction
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

type ttsLang struct {
	Pico   string
	Espeak string
}

func resolveTTSLang(lang string, text string) ttsLang {
	lang = strings.TrimSpace(lang)
	if lang == "" {
		lang = detectLangFromText(text)
	}
	base := strings.ToLower(strings.Split(strings.ReplaceAll(lang, "_", "-"), "-")[0])
	pico := normalizePicoLang(base)
	espeak := normalizeEspeakLang(base)
	if pico == "" && base == "en" {
		pico = "en-US"
	}
	return ttsLang{Pico: pico, Espeak: espeak}
}

func detectLangFromText(text string) string {
	for _, r := range text {
		switch {
		case unicode.In(r, unicode.Han):
			return "zh-CN"
		case unicode.In(r, unicode.Hiragana, unicode.Katakana):
			return "ja-JP"
		case unicode.In(r, unicode.Hangul):
			return "ko-KR"
		case unicode.In(r, unicode.Cyrillic):
			return "ru-RU"
		case unicode.In(r, unicode.Arabic):
			return "ar-SA"
		case unicode.In(r, unicode.Devanagari):
			return "hi-IN"
		}
	}
	return "en-US"
}

func normalizePicoLang(base string) string {
	switch base {
	case "en":
		return "en-US"
	case "de":
		return "de-DE"
	case "es":
		return "es-ES"
	case "fr":
		return "fr-FR"
	case "it":
		return "it-IT"
	default:
		return ""
	}
}

func normalizeEspeakLang(base string) string {
	if base == "" {
		return ""
	}
	return base
}

func selectTTSCmd(ctx context.Context, wavPath string, text string, lang ttsLang) *exec.Cmd {
	if commandExists("pico2wave") && lang.Pico != "" {
		// pico2wave writes the WAV file directly.
		return exec.CommandContext(ctx, "pico2wave", "-l", lang.Pico, "-w", wavPath, text)
	}
	if commandExists("espeak-ng") {
		if lang.Espeak != "" {
			return exec.CommandContext(ctx, "espeak-ng", "-v", lang.Espeak, "-w", wavPath, text)
		}
		return exec.CommandContext(ctx, "espeak-ng", "-w", wavPath, text)
	}
	if commandExists("espeak") {
		if lang.Espeak != "" {
			return exec.CommandContext(ctx, "espeak", "-v", lang.Espeak, "-w", wavPath, text)
		}
		return exec.CommandContext(ctx, "espeak", "-w", wavPath, text)
	}
	if commandExists("flite") {
		return exec.CommandContext(ctx, "flite", "-t", text, "-o", wavPath)
	}
	return nil
}

func synthesizeVoiceToOggOpusWithLang(ctx context.Context, cacheDir string, text string, lang string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("missing voice synthesis text")
	}
	// Keep this bounded: huge TTS is slow and can exceed Telegram limits.
	if len(text) > 1200 {
		text = strings.TrimSpace(text[:1200])
	}

	cacheDir = strings.TrimSpace(cacheDir)
	if cacheDir == "" {
		return "", fmt.Errorf("file cache dir is not configured")
	}
	cacheAbs, err := filepath.Abs(cacheDir)
	if err != nil {
		return "", err
	}
	ttsDir := filepath.Join(cacheAbs, "tts")
	if err := os.MkdirAll(ttsDir, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(ttsDir, 0o700)

	sum := sha256.Sum256([]byte(text))
	base := fmt.Sprintf("voice_%d_%s", time.Now().UTC().Unix(), hex.EncodeToString(sum[:8]))
	wavPath := filepath.Join(ttsDir, base+".wav")
	oggPath := filepath.Join(ttsDir, base+".ogg")

	ttsLang := resolveTTSLang(lang, text)
	synthCmd := selectTTSCmd(ctx, wavPath, text, ttsLang)
	if synthCmd == nil {
		return "", fmt.Errorf("no local TTS engine found (install one of: pico2wave, espeak-ng, espeak, flite)")
	}
	out, err := synthCmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("tts synth failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	// Convert to OGG/Opus for Telegram voice.
	if commandExists("ffmpeg") {
		conv := exec.CommandContext(ctx, "ffmpeg", "-y", "-loglevel", "error", "-i", wavPath, "-c:a", "libopus", "-b:a", "24k", "-vbr", "on", "-compression_level", "10", oggPath)
		out, err := conv.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("ffmpeg convert failed: %w: %s", err, strings.TrimSpace(string(out)))
		}
	} else if commandExists("opusenc") {
		conv := exec.CommandContext(ctx, "opusenc", "--quiet", wavPath, oggPath)
		out, err := conv.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("opusenc convert failed: %w: %s", err, strings.TrimSpace(string(out)))
		}
	} else {
		return "", fmt.Errorf("no audio converter found (install ffmpeg or opusenc)")
	}

	_ = os.Remove(wavPath)
	_ = os.Chmod(oggPath, 0o600)
	return oggPath, nil
}

func sanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "file"
	}
	name = filepath.Base(name)
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.' || r == '_' || r == '-' || r == '+':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), "._- ")
	if out == "" {
		return "file"
	}
	const max = 120
	if len(out) > max {
		out = out[:max]
	}
	return out
}

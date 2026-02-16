package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

type SendVoiceTool struct {
	api        API
	defaultTo  int64
	cacheDir   string
	maxBytes   int64
	allowedIDs map[int64]bool
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
	return "Sends a Telegram voice message from a local audio file under file_cache_dir. Use chat_id when not running in an active chat context."
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
				"description": "Path to a local voice file under file_cache_dir (absolute or relative to that directory). Recommended: .ogg or .mp3 file.",
			},
			"filename": map[string]any{
				"type":        "string",
				"description": "Optional filename shown to the user (default: basename of path).",
			},
		},
		"required": []string{"path"},
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

	rawPath, _ := params["path"].(string)
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" {
		return "", fmt.Errorf("missing required param: path")
	}
	rawPath = pathutil.NormalizeFileCacheDirPath(rawPath)

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

	// Voice captions are intentionally not supported by telegram_send_voice.
	if err := t.api.SendVoice(ctx, chatID, pathAbs, filename, ""); err != nil {
		return "", err
	}
	return fmt.Sprintf("sent voice: %s", filename), nil
}

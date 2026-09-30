package discord

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/filecache"
)

// SendFileTool uploads a file from file_cache_dir to the current conversation.
type SendFileTool struct {
	api              API
	channelID        string
	replyToMessageID string
	cacheDir         string
	maxBytes         int64
}

// DefaultFileMaxBytes is Discord's upload limit for bots without boosts.
const DefaultFileMaxBytes = int64(10 << 20)

func NewSendFileTool(api API, channelID, replyToMessageID, cacheDir string, maxBytes int64) *SendFileTool {
	if maxBytes <= 0 {
		maxBytes = DefaultFileMaxBytes
	}
	return &SendFileTool{
		api: api, channelID: strings.TrimSpace(channelID), replyToMessageID: strings.TrimSpace(replyToMessageID),
		cacheDir: strings.TrimSpace(cacheDir), maxBytes: maxBytes,
	}
}

func (t *SendFileTool) Name() string { return "discord_send_file" }

func (t *SendFileTool) Description() string {
	return "Uploads a local file under file_cache_dir to the current Discord conversation. Use it to send generated artifacts. Files over 10 MB are refused."
}

func (t *SendFileTool) ParameterSchema() string {
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"path":     map[string]any{"type": "string", "description": "Path to a local file under file_cache_dir, absolute or relative to that directory."},
			"filename": map[string]any{"type": "string", "description": "Optional filename shown in Discord. Defaults to the file basename."},
			"message":  map[string]any{"type": "string", "description": "Optional text sent with the file."},
		},
		"required": []string{"path"},
	}
	raw, _ := json.MarshalIndent(schema, "", "  ")
	return string(raw)
}

func (t *SendFileTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.api == nil || t.channelID == "" {
		return "", fmt.Errorf("discord_send_file is disabled")
	}
	rawPath, _ := params["path"].(string)
	path, err := filecache.ResolveFile(t.cacheDir, strings.TrimSpace(rawPath), t.maxBytes)
	if err != nil {
		return "", err
	}
	filename, _ := params["filename"].(string)
	if filename = strings.TrimSpace(filename); filename == "" {
		filename = filepath.Base(path)
	}
	filename = filecache.SanitizeFilename(filename)
	message, _ := params["message"].(string)
	if err := t.api.SendFile(ctx, t.channelID, path, filename, strings.TrimSpace(message), t.replyToMessageID); err != nil {
		return "", err
	}
	return "uploaded file: " + filename, nil
}

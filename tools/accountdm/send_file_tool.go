// Package accountdm holds the tools the agent can use in a WeChat or WhatsApp private chat.
package accountdm

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/filecache"
)

// SendFunc sends a local file to the conversation's user, with an optional message.
type SendFunc func(ctx context.Context, path, filename, message string) error

// SendFileTool uploads a file from file_cache_dir to the user of the current conversation.
type SendFileTool struct {
	name     string
	platform string
	send     SendFunc
	cacheDir string
	maxBytes int64
}

// NewSendFileTool builds "<channel>_send_file"; platform is the name the description uses.
func NewSendFileTool(channel, platform string, send SendFunc, cacheDir string, maxBytes int64) *SendFileTool {
	return &SendFileTool{
		name: strings.TrimSpace(channel) + "_send_file", platform: strings.TrimSpace(platform),
		send: send, cacheDir: strings.TrimSpace(cacheDir), maxBytes: maxBytes,
	}
}

func (t *SendFileTool) Name() string { return t.name }

func (t *SendFileTool) Description() string {
	return fmt.Sprintf("Sends a local file under file_cache_dir to the user in this %s chat: an image or video is sent as one, anything else as a file. Use it to send generated artifacts. Files over %d MB are refused.", t.platform, t.maxBytes>>20)
}

func (t *SendFileTool) ParameterSchema() string {
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"path":     map[string]any{"type": "string", "description": "Path to a local file under file_cache_dir, absolute or relative to that directory."},
			"filename": map[string]any{"type": "string", "description": "Optional file name shown to the user. Defaults to the file basename."},
			"message":  map[string]any{"type": "string", "description": "Optional text sent with the file."},
		},
		"required": []string{"path"},
	}
	raw, _ := json.MarshalIndent(schema, "", "  ")
	return string(raw)
}

func (t *SendFileTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.send == nil {
		return "", fmt.Errorf("%s is disabled", t.Name())
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
	if err := t.send(ctx, path, filename, strings.TrimSpace(message)); err != nil {
		return "", err
	}
	return "sent file: " + filename, nil
}

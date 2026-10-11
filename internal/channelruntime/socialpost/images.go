package socialpost

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/imagehistory"
)

// saveImages downloads a post's images to file_cache_dir/<channel>/ and returns their paths.
func saveImages(ctx context.Context, opts Options, post Post, logger *slog.Logger) []string {
	if len(post.Images) == 0 || strings.TrimSpace(opts.FileCacheDir) == "" {
		return nil
	}
	dir, err := imagehistory.DownloadDir(opts.FileCacheDir, "", opts.Channel)
	if err != nil {
		logger.Warn("image_dir_unavailable", "error", err.Error())
		return nil
	}
	var paths []string
	for i, image := range post.Images {
		if i >= llmMaxImages || image.Fetch == nil {
			break
		}
		data, mimeType, err := image.Fetch(ctx)
		if err != nil {
			logger.Warn("image_download_failed", "post_id", post.ID, "error", err.Error())
			continue
		}
		if mimeType = strings.TrimSpace(mimeType); mimeType == "" {
			mimeType = http.DetectContentType(data)
		}
		path := filepath.Join(dir, fmt.Sprintf("%s_post_%s_%d%s", opts.Channel, safeName(post.ID), i, extension(mimeType)))
		if err := os.WriteFile(path, data, 0o600); err != nil {
			logger.Warn("image_save_failed", "post_id", post.ID, "error", err.Error())
			continue
		}
		paths = append(paths, path)
	}
	return paths
}

func extension(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0])) {
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	}
	return ".jpg"
}

func safeName(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if len(out) > 80 {
		out = out[len(out)-80:]
	}
	return out
}

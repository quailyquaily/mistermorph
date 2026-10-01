package accountdm

import (
	"context"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/imagehistory"
	"github.com/quailyquaily/mistermorph/internal/filecache"
	"github.com/quailyquaily/mistermorph/internal/imagemime"
)

const (
	// llmMaxImages and llmImageMaxBytes bound the images given to the model with one message, as on
	// Discord. Larger or further images are still saved and named in the message.
	llmMaxImages     = 3
	llmImageMaxBytes = int64(5 << 20)
)

// savedMedia is what an inbound message's media became: images for the model, and a note naming
// every saved or failed attachment, added to the message text.
type savedMedia struct {
	Images []busruntime.ImageAttachment
	Note   string
}

// saveInboundMedia downloads a message's media into file_cache_dir/<channel>/.
func saveInboundMedia(ctx context.Context, channel busruntime.Channel, cacheDir string, in Inbound, logger *slog.Logger) savedMedia {
	var out savedMedia
	dir, err := imagehistory.DownloadDir(cacheDir, "", string(channel))
	if err != nil {
		logger.Warn("media_dir_unavailable", "error", err.Error())
		return savedMedia{Note: "The message's attachments could not be saved: " + err.Error()}
	}
	var lines []string
	for i, media := range in.Media {
		label := mediaLabel(media)
		if media.Fetch == nil {
			lines = append(lines, fmt.Sprintf("- %s: could not be downloaded", label))
			continue
		}
		data, mimeType, err := media.Fetch(ctx)
		if err != nil {
			logger.Warn("media_download_failed", "message_id", in.MessageID, "kind", media.Kind, "error", err.Error())
			lines = append(lines, fmt.Sprintf("- %s: could not be downloaded (%s)", label, err.Error()))
			continue
		}
		if mimeType = strings.TrimSpace(mimeType); mimeType == "" {
			mimeType = strings.TrimSpace(media.MIMEType)
		}
		if mimeType == "" || mimeType == "application/octet-stream" {
			mimeType = http.DetectContentType(data)
		}
		path := filepath.Join(dir, mediaFilename(channel, in.MessageID, i, media, mimeType))
		if err := writePrivateFile(path, data); err != nil {
			logger.Warn("media_save_failed", "message_id", in.MessageID, "error", err.Error())
			lines = append(lines, fmt.Sprintf("- %s: could not be saved (%s)", label, err.Error()))
			continue
		}
		rel := filepath.ToSlash(filepath.Join("file_cache_dir", string(channel), filepath.Base(path)))
		if media.Kind == "image" && strings.HasPrefix(imagemime.Normalize(mimeType), "image/") {
			out.Images = append(out.Images, busruntime.ImageAttachment{Path: path, SourceMessageID: in.MessageID, SourceAttachmentID: fmt.Sprint(i), MIMEType: mimeType})
			continue
		}
		lines = append(lines, fmt.Sprintf("- %s (%s, %s): %s", label, baseMIME(mimeType), humanSize(int64(len(data))), rel))
	}
	if len(lines) > 0 {
		out.Note = "Attachments saved to file_cache_dir (read them with read_file or the tools that fit):\n" + strings.Join(lines, "\n")
	}
	return out
}

// mediaText is the text a message with media starts its task with.
func mediaText(text string, saved savedMedia, in Inbound) string {
	text = strings.TrimSpace(text)
	if text == "" {
		switch {
		case len(saved.Images) == 1 && len(in.Media) == 1:
			text = "User sent an image."
		case len(saved.Images) == len(in.Media):
			text = fmt.Sprintf("User sent %d images.", len(saved.Images))
		case len(in.Media) == 1:
			text = "User sent " + article(mediaLabel(in.Media[0])) + "."
		default:
			text = fmt.Sprintf("User sent %d attachments.", len(in.Media))
		}
	}
	if saved.Note != "" {
		text += "\n\n" + saved.Note
	}
	return text
}

func mediaLabel(media Media) string {
	kind := strings.TrimSpace(media.Kind)
	if kind == "audio" {
		kind = "audio message"
	}
	if kind == "" {
		kind = "file"
	}
	if name := strings.TrimSpace(media.Name); name != "" && media.Kind == "file" {
		return kind + " " + name
	}
	return kind
}

func article(label string) string {
	if label != "" && strings.ContainsRune("aeiou", rune(label[0])) {
		return "an " + label
	}
	return "a " + label
}

func mediaFilename(channel busruntime.Channel, messageID string, index int, media Media, mimeType string) string {
	name := media.Kind
	if raw := strings.TrimSpace(media.Name); raw != "" {
		name = filecache.SanitizeFilename(raw)
	}
	if filepath.Ext(name) == "" {
		name += extensionFor(mimeType)
	}
	id := filecache.SanitizeFilename(messageID)
	if len(id) > 40 {
		id = id[len(id)-40:]
	}
	return fmt.Sprintf("%s_%s_%d_%s", channel, id, index, name)
}

func extensionFor(mimeType string) string {
	if ext := imagemime.Extension(mimeType); ext != "" {
		return ext
	}
	switch baseMIME(mimeType) {
	case "audio/ogg":
		return ".ogg"
	case "audio/silk":
		return ".silk"
	case "video/mp4":
		return ".mp4"
	case "application/pdf":
		return ".pdf"
	}
	if exts, _ := mime.ExtensionsByType(baseMIME(mimeType)); len(exts) > 0 {
		return exts[0]
	}
	return ".bin"
}

func baseMIME(mimeType string) string {
	return strings.ToLower(strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0]))
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%d KB", n>>10)
	}
	return fmt.Sprintf("%d bytes", n)
}

func writePrivateFile(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err = tmp.Write(data); err == nil {
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
	}
	return err
}

// outboundFile describes a file the agent asked to send.
func outboundFile(path, filename, caption string) OutboundFile {
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if mimeType == "" {
		if f, err := os.Open(path); err == nil {
			head := make([]byte, 512)
			n, _ := f.Read(head)
			_ = f.Close()
			mimeType = http.DetectContentType(head[:n])
		}
	}
	return OutboundFile{Path: path, Name: filename, MIMEType: mimeType, Caption: caption}
}

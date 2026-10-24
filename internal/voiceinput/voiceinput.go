// Package voiceinput turns voice input into text with the model llm.routes.transcription points at.
package voiceinput

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

// MaxBytes is the largest audio sent for transcription, the OpenAI upload limit. Larger audio
// stays a file.
const MaxBytes = 25 << 20

// Scenes tag transcription requests in usage records.
const (
	SceneChannel = "channel.voice"
	SceneConsole = "console.voice"
)

// NewClient builds the transcription client from LLM values, recording usage under journalDir
// (none when empty). It returns (nil, nil) when llm.routes.transcription is not set.
func NewClient(values llmutil.RuntimeValues, journalDir string, logger *slog.Logger) (llm.TranscriptionClient, error) {
	routeValues, err := llmutil.TranscriptionRouteValues(values)
	if errors.Is(err, llmutil.ErrTranscriptionRouteUnset) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	client, err := llmutil.TranscriptionClientFromValues(routeValues)
	if err != nil {
		return nil, err
	}
	meta, _ := llmutil.ResolveTranscriptionClientMetadata(routeValues)
	return llmstats.WrapTranscriptionClient(client, llmstats.ClientOptions{
		Provider:     meta.Provider,
		APIBase:      meta.Endpoint,
		DefaultModel: meta.Model,
		JournalDir:   journalDir,
		Logger:       logger,
	}), nil
}

// Transcribable reports whether audio with this MIME type or filename can be sent for
// transcription. WeChat's SILK voice is audio that no transcription API reads.
func Transcribable(mimeType, filename string) bool {
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0]))
	if base == "" || base == "application/octet-stream" {
		base = strings.ToLower(mime.TypeByExtension(strings.ToLower(filepath.Ext(filename))))
		base = strings.SplitN(base, ";", 2)[0]
	}
	switch base {
	case "audio/silk", "audio/x-silk":
		return false
	}
	return strings.HasPrefix(base, "audio/") || base == "video/webm" || base == "video/mp4"
}

// Transcribe returns the text spoken in audio. A nil client returns "" and no error.
func Transcribe(ctx context.Context, client llm.TranscriptionClient, audio llm.AudioInput, scene string) (string, error) {
	if client == nil {
		return "", nil
	}
	if len(audio.Data) == 0 {
		return "", fmt.Errorf("audio is empty")
	}
	if len(audio.Data) > MaxBytes {
		return "", fmt.Errorf("audio is %d MB, over the %d MB transcription limit", len(audio.Data)>>20, MaxBytes>>20)
	}
	res, err := client.Transcribe(ctx, llm.TranscriptionRequest{Audio: audio, Scene: scene})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(res.Text), nil
}

// TranscribeFile transcribes a saved audio file. A nil client returns "" and no error.
func TranscribeFile(ctx context.Context, client llm.TranscriptionClient, path, mimeType, scene string) (string, error) {
	if client == nil {
		return "", nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > MaxBytes {
		return "", fmt.Errorf("audio is %d MB, over the %d MB transcription limit", info.Size()>>20, MaxBytes>>20)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return Transcribe(ctx, client, llm.AudioInput{Filename: filepath.Base(path), MIMEType: mimeType, Data: data}, scene)
}

// Note is how a voice message's transcript is added to the message text.
func Note(transcript string) string {
	transcript = strings.TrimSpace(transcript)
	if transcript == "" {
		return "Voice message transcript: (no speech recognized)"
	}
	return "Voice message transcript:\n" + transcript
}

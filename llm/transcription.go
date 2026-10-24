package llm

import (
	"context"
	"time"
)

// AudioInput is the audio to transcribe. Filename or MIMEType names its format
// (e.g. "voice.ogg", "audio/ogg"); providers that cannot sniff it need one of them.
type AudioInput struct {
	Filename string
	MIMEType string
	Data     []byte
}

type TranscriptionRequest struct {
	Provider string
	Model    string
	Audio    AudioInput
	// Language is an optional ISO-639-1 hint ("en", "ja").
	Language string
	// Prompt is optional context that guides spelling and style.
	Prompt string
	// Scene tags the request in usage records (e.g. "channel.voice", "console.voice").
	Scene string
}

type TranscriptionResult struct {
	Text     string
	Language string
	// AudioSeconds is the length of the audio, when the provider reports it.
	AudioSeconds float64
	Usage        Usage
	Duration     time.Duration
}

type TranscriptionClient interface {
	Transcribe(ctx context.Context, req TranscriptionRequest) (TranscriptionResult, error)
}

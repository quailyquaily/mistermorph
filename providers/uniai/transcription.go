package uniai

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/lyricat/goutils/structs"
	"github.com/quailyquaily/mistermorph/llm"
	uniaiapi "github.com/quailyquaily/uniai"
)

func (c *Client) Transcribe(ctx context.Context, req llm.TranscriptionRequest) (llm.TranscriptionResult, error) {
	start := time.Now()
	if len(req.Audio.Data) == 0 {
		return llm.TranscriptionResult{}, fmt.Errorf("uniai: audio is empty")
	}
	if c.requestTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.requestTimeout)
		defer cancel()
	}
	resp, err := c.client.Audio(ctx, buildTranscriptionOptions(req, c.provider, c.model)...)
	if err != nil {
		return llm.TranscriptionResult{}, err
	}
	if resp == nil {
		return llm.TranscriptionResult{}, fmt.Errorf("uniai: empty transcription response")
	}
	return llm.TranscriptionResult{
		Text:         strings.TrimSpace(resp.Text),
		Language:     strings.TrimSpace(resp.Language),
		AudioSeconds: transcriptionSeconds(resp),
		Usage:        toLLMAudioUsage(resp.Usage),
		Duration:     time.Since(start),
	}, nil
}

func buildTranscriptionOptions(req llm.TranscriptionRequest, defaultProvider, defaultModel string) []uniaiapi.AudioOption {
	provider := firstNonEmpty(req.Provider, defaultProvider)
	opts := []uniaiapi.AudioOption{
		uniaiapi.WithAudioModel(firstNonEmpty(req.Model, defaultModel)),
		uniaiapi.WithAudioFile(req.Audio.Data, strings.TrimSpace(req.Audio.Filename), strings.TrimSpace(req.Audio.MIMEType)),
	}
	if provider != "" {
		opts = append(opts, uniaiapi.WithAudioProvider(provider))
	}
	extra := structs.NewJSONMap()
	if language := strings.TrimSpace(req.Language); language != "" {
		extra["language"] = language
	}
	if prompt := strings.TrimSpace(req.Prompt); prompt != "" {
		extra["prompt"] = prompt
	}
	if len(extra) > 0 {
		switch provider {
		case "cloudflare":
			opts = append(opts, uniaiapi.WithAudioOptions(uniaiapi.AudioOptions{Cloudflare: extra}))
		default:
			opts = append(opts, uniaiapi.WithAudioOptions(uniaiapi.AudioOptions{OpenAI: extra}))
		}
	}
	return opts
}

func transcriptionSeconds(resp *uniaiapi.AudioResult) float64 {
	if resp.Duration > 0 {
		return resp.Duration
	}
	if resp.Usage != nil {
		return resp.Usage.Seconds
	}
	return 0
}

func toLLMAudioUsage(usage *uniaiapi.AudioUsage) llm.Usage {
	if usage == nil {
		return llm.Usage{}
	}
	details := map[string]int{}
	if usage.InputTextTokens > 0 {
		details["input_text_tokens"] = usage.InputTextTokens
	}
	if usage.InputAudioTokens > 0 {
		details["input_audio_tokens"] = usage.InputAudioTokens
	}
	return llm.Usage{
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		TotalTokens:  usage.TotalTokens,
		Cache:        llm.UsageCache{Details: details},
	}
}

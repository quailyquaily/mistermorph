package llmbench

import (
	"context"
	_ "embed"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

// speechSample is "The quick brown fox jumps over the lazy dog." spoken by espeak-ng (en-us,
// 140 wpm): 3.7 seconds of 16 kHz mono MP3.
//
//go:embed speech_sample.mp3
var speechSample []byte

// speechSampleWords are the words of the sample a transcript must have. Synthetic speech is
// heard imperfectly, so speechSampleMinWords of them are enough.
var speechSampleWords = []string{"quick", "brown", "fox", "jumps", "lazy", "dog"}

const speechSampleMinWords = 4

var transcriptWord = regexp.MustCompile(`[a-z]+`)

// RunTranscriptionBenchmark checks that the client turns speech into text: it sends a short
// spoken sentence and looks for its words in the transcript. buildErr is why the client could not
// be made (a provider without transcription, say); the benchmark then fails with it.
func RunTranscriptionBenchmark(ctx context.Context, client llm.TranscriptionClient, buildErr error, model string) BenchmarkResult {
	const id = "transcription"
	if buildErr != nil {
		return BenchmarkResult{ID: id, Error: strings.TrimSpace(buildErr.Error())}
	}
	if client == nil {
		return BenchmarkResult{ID: id, Error: "no transcription client"}
	}
	start := time.Now()
	res, err := client.Transcribe(ctx, llm.TranscriptionRequest{
		Model:    strings.TrimSpace(model),
		Audio:    llm.AudioInput{Filename: "benchmark.mp3", MIMEType: "audio/mpeg", Data: speechSample},
		Language: "en",
		Scene:    "console.settings_test.transcription",
	})
	durationMS := time.Since(start).Milliseconds()
	if err != nil {
		return BenchmarkResult{ID: id, DurationMS: durationMS, Error: strings.TrimSpace(err.Error()), RawResponse: RawResponseFromError(err)}
	}
	text := strings.TrimSpace(res.Text)
	if text == "" {
		return BenchmarkResult{ID: id, DurationMS: durationMS, Error: "the transcript is empty"}
	}
	heard := map[string]bool{}
	for _, word := range transcriptWord.FindAllString(strings.ToLower(text), -1) {
		heard[word] = true
	}
	matched := 0
	for _, word := range speechSampleWords {
		if heard[word] {
			matched++
		}
	}
	if matched < speechSampleMinWords {
		return BenchmarkResult{
			ID:          id,
			DurationMS:  durationMS,
			Error:       fmt.Sprintf("the transcript does not match the spoken sentence (%d of %d words)", matched, len(speechSampleWords)),
			RawResponse: text,
		}
	}
	return BenchmarkResult{ID: id, OK: true, DurationMS: durationMS, Detail: text, RawResponse: text}
}

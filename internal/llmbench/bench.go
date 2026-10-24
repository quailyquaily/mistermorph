package llmbench

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/jsonutil"
	"github.com/quailyquaily/mistermorph/llm"
)

var errorStatusPattern = regexp.MustCompile(`(?is)\bstatus\s+\d{3}\s*:\s*(.+)$`)

type BenchmarkResult struct {
	ID          string `json:"id"`
	OK          bool   `json:"ok"`
	DurationMS  int64  `json:"duration_ms"`
	Detail      string `json:"detail,omitempty"`
	Error       string `json:"error,omitempty"`
	RawResponse string `json:"raw_response,omitempty"`
}

// BenchmarksPerRun is how many benchmarks a Chat profile runs: text, JSON, tool calling and
// Evaluate. See BenchmarkIDs for the other kinds of profile.
const BenchmarksPerRun = 4

// Benchmark IDs, as results and the Console name them.
const (
	BenchmarkTextReply     = "text_reply"
	BenchmarkJSONResponse  = "json_response"
	BenchmarkToolCalling   = "tool_calling"
	BenchmarkEvaluate      = "evaluate"
	BenchmarkTranscription = "transcription"
)

type ProfileMetadata struct {
	Profile  string
	Provider string
	APIBase  string
	Model    string
	// EvaluateOnly profiles cannot chat, so they run only the Evaluate benchmark.
	EvaluateOnly bool
	// Abilities are the profile's normalized abilities; none means text. A profile with
	// transcription runs the transcription benchmark, and one without text runs no chat benchmark.
	Abilities []string
}

// Clients are what a profile is benchmarked through: Chat for the chat and Evaluate benchmarks,
// Transcription for the transcription one. TranscriptionErr is why the transcription client
// could not be made.
type Clients struct {
	Chat             llm.Client
	Transcription    llm.TranscriptionClient
	TranscriptionErr error
}

// BenchmarkIDs lists the benchmarks a profile runs, in order. A profile that chats runs text,
// JSON, tool calling and Evaluate; an Evaluate-only one runs Evaluate; one with transcription
// adds the transcription benchmark, and a transcription-only one runs just that.
func BenchmarkIDs(meta ProfileMetadata) []string {
	var ids []string
	switch {
	case meta.EvaluateOnly:
		ids = []string{BenchmarkEvaluate}
	case hasAbility(meta.Abilities, "text"):
		ids = []string{BenchmarkTextReply, BenchmarkJSONResponse, BenchmarkToolCalling, BenchmarkEvaluate}
	}
	if hasAbility(meta.Abilities, "transcription") {
		ids = append(ids, BenchmarkTranscription)
	}
	if len(ids) == 0 {
		// An image-only profile still answers chat requests; it has nothing better to test.
		ids = []string{BenchmarkTextReply, BenchmarkJSONResponse, BenchmarkToolCalling, BenchmarkEvaluate}
	}
	return ids
}

// NeedsChat reports whether any of the profile's benchmarks go through a chat client.
func NeedsChat(meta ProfileMetadata) bool {
	for _, id := range BenchmarkIDs(meta) {
		if id != BenchmarkTranscription {
			return true
		}
	}
	return false
}

// NeedsTranscription reports whether the profile runs the transcription benchmark.
func NeedsTranscription(meta ProfileMetadata) bool {
	return hasAbility(meta.Abilities, "transcription")
}

func hasAbility(abilities []string, ability string) bool {
	if len(abilities) == 0 {
		return ability == "text"
	}
	for _, value := range abilities {
		if strings.EqualFold(strings.TrimSpace(value), ability) {
			return true
		}
	}
	return false
}

type ProfileResult struct {
	Profile    string            `json:"profile"`
	Provider   string            `json:"provider,omitempty"`
	APIBase    string            `json:"api_base,omitempty"`
	Model      string            `json:"model,omitempty"`
	Benchmarks []BenchmarkResult `json:"benchmarks,omitempty"`
	Error      string            `json:"error,omitempty"`
}

func (r ProfileResult) OK() bool {
	if strings.TrimSpace(r.Error) != "" {
		return false
	}
	for _, benchmark := range r.Benchmarks {
		if !benchmark.OK {
			return false
		}
	}
	return true
}

func Run(ctx context.Context, clients Clients, meta ProfileMetadata) ProfileResult {
	return RunWithProgress(ctx, clients, meta, nil)
}

// RunWithProgress runs the profile's benchmarks (BenchmarkIDs) in order, reporting each as it
// finishes.
func RunWithProgress(
	ctx context.Context,
	clients Clients,
	meta ProfileMetadata,
	onBenchmark func(BenchmarkResult),
) ProfileResult {
	model := strings.TrimSpace(meta.Model)
	ids := BenchmarkIDs(meta)
	results := make([]BenchmarkResult, 0, len(ids))
	for _, id := range ids {
		var result BenchmarkResult
		switch id {
		case BenchmarkTextReply:
			result = RunTextBenchmark(ctx, clients.Chat, model)
		case BenchmarkJSONResponse:
			result = RunJSONBenchmark(ctx, clients.Chat, model)
		case BenchmarkToolCalling:
			result = RunToolCallingBenchmark(ctx, clients.Chat, model)
		case BenchmarkEvaluate:
			result = RunEvaluateBenchmark(ctx, clients.Chat, model)
		case BenchmarkTranscription:
			result = RunTranscriptionBenchmark(ctx, clients.Transcription, clients.TranscriptionErr, model)
		}
		if onBenchmark != nil {
			onBenchmark(result)
		}
		results = append(results, result)
	}
	return ProfileResult{
		Profile:    strings.TrimSpace(meta.Profile),
		Provider:   strings.TrimSpace(meta.Provider),
		APIBase:    strings.TrimSpace(meta.APIBase),
		Model:      model,
		Benchmarks: results,
	}
}

func RunTextBenchmark(ctx context.Context, client llm.Client, model string) BenchmarkResult {
	start := time.Now()
	result, err := client.Chat(ctx, llm.Request{
		Model: strings.TrimSpace(model),
		Scene: "console.settings_test.text_reply",
		Messages: []llm.Message{
			{Role: "system", Content: "You're acting the linux cmd `echo`, will echo back the text."},
			{Role: "user", Content: "OK"},
		},
		Parameters: map[string]any{
			"max_tokens": 1024,
		},
	})
	durationMS := time.Since(start).Milliseconds()
	if err != nil {
		return BenchmarkResult{
			ID:          BenchmarkTextReply,
			OK:          false,
			DurationMS:  durationMS,
			Error:       strings.TrimSpace(err.Error()),
			RawResponse: RawResponseFromError(err),
		}
	}

	text := strings.TrimSpace(result.Text)
	if text == "" {
		return BenchmarkResult{
			ID:          BenchmarkTextReply,
			OK:          false,
			DurationMS:  durationMS,
			Error:       "received an empty text reply",
			RawResponse: RawResponse(result),
		}
	}

	return BenchmarkResult{
		ID:          BenchmarkTextReply,
		OK:          true,
		DurationMS:  durationMS,
		Detail:      SummarizeBenchmarkDetail(text),
		RawResponse: RawResponse(result),
	}
}

func RunJSONBenchmark(ctx context.Context, client llm.Client, model string) BenchmarkResult {
	start := time.Now()
	result, err := client.Chat(ctx, llm.Request{
		Model:     strings.TrimSpace(model),
		Scene:     "console.settings_test.json_response",
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: "You wrap the input by a JSON object and echo back the JSON object only. for example, IF input is `Hello` THEN return {\"message\": \"Hello\"}."},
			{Role: "user", Content: "Hello"},
		},
		Parameters: map[string]any{
			"max_tokens": 1024,
		},
	})
	durationMS := time.Since(start).Milliseconds()
	if err != nil {
		return BenchmarkResult{
			ID:          BenchmarkJSONResponse,
			OK:          false,
			DurationMS:  durationMS,
			Error:       strings.TrimSpace(err.Error()),
			RawResponse: RawResponseFromError(err),
		}
	}

	var payload struct {
		Message string `json:"message"`
	}
	if err := jsonutil.DecodeWithFallback(result.Text, &payload); err != nil {
		return BenchmarkResult{
			ID:          BenchmarkJSONResponse,
			OK:          false,
			DurationMS:  durationMS,
			Error:       "response was not valid json",
			RawResponse: RawResponse(result),
		}
	}
	if strings.TrimSpace(payload.Message) != "Hello" {
		return BenchmarkResult{
			ID:          BenchmarkJSONResponse,
			OK:          false,
			DurationMS:  durationMS,
			Error:       "json response is not so correct",
			RawResponse: RawResponse(result),
		}
	}

	return BenchmarkResult{
		ID:          BenchmarkJSONResponse,
		OK:          true,
		DurationMS:  durationMS,
		Detail:      "Hello",
		RawResponse: RawResponse(result),
	}
}

func RunToolCallingBenchmark(ctx context.Context, client llm.Client, model string) BenchmarkResult {
	start := time.Now()
	result, err := client.Chat(ctx, llm.Request{
		Model: strings.TrimSpace(model),
		Scene: "console.settings_test.tool_calling",
		Messages: []llm.Message{
			{Role: "system", Content: "You are a tool calling test. Always call the ping tool exactly once."},
			{Role: "user", Content: "Call the ping tool now."},
		},
		Tools: []llm.Tool{
			{
				Name:           "ping",
				Description:    "Connectivity check tool.",
				ParametersJSON: `{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`,
			},
		},
		Parameters: map[string]any{
			"max_tokens": 1024,
		},
	})
	durationMS := time.Since(start).Milliseconds()
	if err != nil {
		return BenchmarkResult{
			ID:          BenchmarkToolCalling,
			OK:          false,
			DurationMS:  durationMS,
			Error:       strings.TrimSpace(err.Error()),
			RawResponse: RawResponseFromError(err),
		}
	}

	for _, call := range result.ToolCalls {
		if strings.EqualFold(strings.TrimSpace(call.Name), "ping") {
			return BenchmarkResult{
				ID:          BenchmarkToolCalling,
				OK:          true,
				DurationMS:  durationMS,
				Detail:      "called ping",
				RawResponse: RawResponse(result),
			}
		}
	}

	detail := SummarizeBenchmarkDetail(result.Text)
	if detail == "" {
		detail = "model replied without calling the tool"
	} else {
		detail = "model replied without calling the tool: " + detail
	}
	return BenchmarkResult{
		ID:          BenchmarkToolCalling,
		OK:          false,
		DurationMS:  durationMS,
		Error:       detail,
		RawResponse: RawResponse(result),
	}
}

func RawResponse(result llm.Result) string {
	text := strings.TrimSpace(result.Text)
	if len(result.ToolCalls) == 0 && result.JSON == nil {
		return text
	}

	payload := map[string]any{}
	if text != "" {
		payload["text"] = text
	}
	if result.JSON != nil {
		payload["json"] = result.JSON
	}
	if len(result.ToolCalls) > 0 {
		payload["tool_calls"] = result.ToolCalls
	}
	serialized, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return text
	}
	return string(serialized)
}

func RawResponseFromError(err error) string {
	if err == nil {
		return ""
	}

	text := strings.TrimSpace(err.Error())
	if text == "" {
		return ""
	}

	matches := errorStatusPattern.FindStringSubmatch(text)
	if len(matches) == 2 {
		if raw := strings.TrimSpace(matches[1]); raw != "" {
			return raw
		}
	}

	return text
}

func SummarizeBenchmarkDetail(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	const maxLen = 140
	runes := []rune(text)
	if len(runes) <= maxLen {
		return text
	}
	return string(runes[:maxLen-1]) + "…"
}

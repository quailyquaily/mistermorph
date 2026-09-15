package uniai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
	uniaiapi "github.com/quailyquaily/uniai"
)

func TestClientStreamsAnthropicAndGemini(t *testing.T) {
	tests := []struct {
		provider      string
		model         string
		reasoningType llm.ReasoningDeltaType
		signature     string
		chunks        []string
	}{
		{
			provider:      "anthropic",
			model:         "claude-sonnet-4-6",
			reasoningType: llm.ReasoningDeltaThinking,
			chunks: []string{
				`{"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10}}}`,
				`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
				`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"inspect first"}}`,
				`{"type":"content_block_stop","index":0}`,
				`{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
				`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checking "}}`,
				`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"the file."}}`,
				`{"type":"content_block_stop","index":1}`,
				`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool_1","name":"read_file"}}`,
				`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"README.md\"}"}}`,
				`{"type":"content_block_stop","index":2}`,
				`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}`,
				`{"type":"message_stop"}`,
			},
		},
		{
			provider:      "gemini",
			model:         "gemini-2.5-pro",
			reasoningType: llm.ReasoningDeltaSummary,
			signature:     "tool_signature",
			chunks: []string{
				`{"candidates":[{"content":{"parts":[{"thought":true,"text":"inspect first"}]}}]}`,
				`{"candidates":[{"content":{"parts":[{"text":"Checking "}]}}]}`,
				`{"candidates":[{"content":{"parts":[{"text":"the file."}]}}]}`,
				`{"candidates":[{"content":{"parts":[{"thoughtSignature":"tool_signature","functionCall":{"name":"read_file","args":{"path":"README.md"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}`,
			},
		},
	}
	for _, tc := range tests {
		for _, model := range []string{tc.model, "deployment-alias"} {
			t.Run(tc.provider+"/"+model, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var payload struct {
						Stream bool `json:"stream"`
					}
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Errorf("decode request: %v", err)
						http.Error(w, "invalid request", http.StatusBadRequest)
						return
					}
					if tc.provider == "anthropic" && !payload.Stream ||
						tc.provider == "gemini" && (!strings.HasSuffix(r.URL.Path, ":streamGenerateContent") || r.URL.Query().Get("alt") != "sse") {
						t.Errorf("request did not enable streaming: path=%s stream=%v", r.URL.Path, payload.Stream)
						http.Error(w, "streaming required", http.StatusBadRequest)
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					for _, chunk := range tc.chunks {
						if tc.provider == "anthropic" {
							var event struct {
								Type string `json:"type"`
							}
							if err := json.Unmarshal([]byte(chunk), &event); err != nil {
								t.Errorf("decode fixture: %v", err)
								return
							}
							_, _ = fmt.Fprintf(w, "event: %s\n", event.Type)
						}
						_, _ = fmt.Fprintf(w, "data: %s\n\n", chunk)
						w.(http.Flusher).Flush()
					}
				}))
				defer server.Close()

				client := &Client{
					provider: tc.provider,
					model:    model,
					client: uniaiapi.New(uniaiapi.Config{
						Provider:         tc.provider,
						AnthropicAPIBase: server.URL,
						AnthropicAPIKey:  "test-key",
						GeminiAPIBase:    server.URL,
						GeminiAPIKey:     "test-key",
					}),
				}
				var events []llm.StreamEvent
				var responseLogged bool
				req := llm.Request{
					Model:            model,
					Messages:         []llm.Message{{Role: "user", Content: "Read README.md"}},
					Tools:            []llm.Tool{{Name: "read_file", ParametersJSON: `{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}`}},
					ReasoningDetails: true,
					OnStream: func(event llm.StreamEvent) error {
						events = append(events, event)
						return nil
					},
					DebugFn: func(label, _ string) {
						if label == tc.provider+".chat.response" {
							responseLogged = true
						}
					},
				}
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				result, err := client.Chat(ctx, req)
				if err != nil {
					t.Fatalf("Chat() error = %v", err)
				}
				var textDeltas []string
				var reasoning string
				var toolName, toolArgs string
				doneCount := 0
				for _, event := range events {
					if event.Delta != "" {
						textDeltas = append(textDeltas, event.Delta)
					}
					if delta := event.ReasoningDelta; delta != nil {
						reasoning += delta.Delta
						if delta.Type != tc.reasoningType {
							t.Errorf("reasoning type = %q, want %q", delta.Type, tc.reasoningType)
						}
					}
					if delta := event.ToolCallDelta; delta != nil {
						if delta.Name != "" {
							toolName = delta.Name
						}
						toolArgs += delta.ArgsChunk
					}
					if event.Done {
						doneCount++
					}
				}
				if !reflect.DeepEqual(textDeltas, []string{"Checking ", "the file."}) || result.Text != "Checking the file." {
					t.Fatalf("text deltas = %q, result text = %q", textDeltas, result.Text)
				}
				if reasoning != "inspect first" {
					t.Fatalf("reasoning = %q, want inspect first", reasoning)
				}
				if toolName != "read_file" || toolArgs != `{"path":"README.md"}` {
					t.Fatalf("streamed tool = %q, args = %q", toolName, toolArgs)
				}
				if len(result.ToolCalls) != 1 || result.ToolCalls[0].Name != toolName ||
					result.ToolCalls[0].Arguments["path"] != "README.md" || result.ToolCalls[0].ThoughtSignature != tc.signature {
					t.Fatalf("result tool calls = %#v", result.ToolCalls)
				}
				last := events[len(events)-1]
				if doneCount != 1 || !last.Done || last.Usage == nil ||
					last.Usage.InputTokens != 10 || last.Usage.OutputTokens != 5 || last.Usage.TotalTokens != 15 ||
					result.Usage.TotalTokens != 15 {
					t.Fatalf("done count = %d, last event = %#v, result usage = %#v", doneCount, last, result.Usage)
				}
				if !responseLogged {
					t.Fatal("streamed response was not logged")
				}

				stopErr := errors.New("stop streaming")
				req.OnStream = func(event llm.StreamEvent) error {
					if event.Done {
						t.Error("received Done after stopping the stream")
					}
					return stopErr
				}
				if _, err := client.Chat(ctx, req); !errors.Is(err, stopErr) {
					t.Fatalf("Chat() error = %v, want callback error", err)
				}
			})
		}
	}
}

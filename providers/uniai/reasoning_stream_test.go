package uniai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/testhttp"
	"github.com/quailyquaily/mistermorph/llm"
	uniaiapi "github.com/quailyquaily/uniai"
	uniaichat "github.com/quailyquaily/uniai/chat"
)

func TestBuildChatOptionsMapsReasoningStream(t *testing.T) {
	var received llm.StreamEvent
	req := llm.Request{
		Model:            "gpt-5.4",
		Messages:         []llm.Message{{Role: "user", Content: "test"}},
		ReasoningDetails: true,
		OnStream: func(event llm.StreamEvent) error {
			received = event
			return nil
		},
	}

	opts := buildChatOptionsForTest(
		req,
		"openai_resp",
		"gpt-5.4",
		"",
		"",
		false,
		uniaiapi.ToolsEmulationOff,
		nil,
		"",
		nil,
	)
	built, err := uniaichat.BuildRequest(opts...)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if !built.Options.ReasoningDetails {
		t.Fatal("ReasoningDetails = false, want true")
	}
	if built.Options.OnStream == nil {
		t.Fatal("OnStream = nil")
	}

	err = built.Options.OnStream(uniaiapi.StreamEvent{
		ReasoningDelta: &uniaiapi.ReasoningDelta{
			Index: 2,
			Type:  uniaiapi.ReasoningDeltaSummary,
			Delta: "inspect first",
		},
	})
	if err != nil {
		t.Fatalf("OnStream: %v", err)
	}
	if received.ReasoningDelta == nil {
		t.Fatal("received.ReasoningDelta = nil")
	}
	if received.ReasoningDelta.Index != 2 ||
		received.ReasoningDelta.Type != llm.ReasoningDeltaSummary ||
		received.ReasoningDelta.Delta != "inspect first" {
		t.Fatalf("received.ReasoningDelta = %#v", received.ReasoningDelta)
	}
}

func TestBuildChatOptionsReasoningDetails(t *testing.T) {
	for _, tc := range []struct {
		provider string
		model    string
		want     bool
	}{
		{provider: "", model: "deployment-alias", want: true},
		{provider: "openai", model: "deployment-alias", want: true},
		{provider: "openai", model: "gpt-4.1", want: true},
		{provider: "openai", model: "kimi-k3", want: true},
		{provider: "deepseek", model: "deployment-alias", want: true},
		{provider: "xai", model: "deployment-alias", want: true},
		{provider: "groq", model: "deployment-alias", want: true},
		{provider: "meta", model: "deployment-alias", want: true},
		{provider: "azure", model: "deployment-alias", want: true},
		{provider: "gemini", model: "gemini-2.5-pro", want: true},
		{provider: "gemini", model: "deployment-alias", want: true},
		{provider: "anthropic", model: "claude-opus-4-7", want: true},
		{provider: "anthropic", model: "claude-3-7-sonnet", want: true},
		{provider: "anthropic", model: "deployment-alias", want: true},
		{provider: "bedrock", model: "deployment-alias", want: true},
		{provider: "openai_resp", model: "gpt-5.4", want: true},
		{provider: "openai_codex", model: "gpt-5.5", want: true},
		{provider: "openai_resp", model: "gpt-4.1", want: false},
		{provider: "xai_oauth", model: "grok-4.1-fast-reasoning", want: false},
		{provider: "sakana", model: "deployment-alias", want: false},
	} {
		t.Run(tc.provider+"/"+tc.model, func(t *testing.T) {
			for _, enabled := range []bool{false, true} {
				client := &Client{provider: tc.provider, model: tc.model}
				built, err := uniaichat.BuildRequest(client.buildChatOptions(llm.Request{
					Messages:         []llm.Message{{Role: "user", Content: "test"}},
					ReasoningDetails: enabled,
				}, false)...)
				if err != nil {
					t.Fatalf("build request: %v", err)
				}
				if want := enabled && tc.want; built.Options.ReasoningDetails != want {
					t.Fatalf("enabled=%v: ReasoningDetails = %v, want %v", enabled, built.Options.ReasoningDetails, want)
				}
			}
		})
	}
}

func TestClientStreamsCompatibleReasoningForCustomModel(t *testing.T) {
	for _, provider := range []string{"", "openai", "deepseek", "xai", "groq", "meta", "azure"} {
		for _, present := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/present=%t", provider, present), func(t *testing.T) {
				serverURL := testhttp.WithDefaultTransport(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var payload map[string]any
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Errorf("decode request: %v", err)
						http.Error(w, "invalid request", http.StatusBadRequest)
						return
					}
					if payload["model"] != "deployment-alias" || payload["stream"] != true {
						t.Errorf("unexpected request: %#v", payload)
					}
					for _, key := range []string{"reasoning", "reasoning_details", "reasoning_effort"} {
						if _, ok := payload[key]; ok {
							t.Errorf("reasoning capture added request parameter %q", key)
						}
					}
					w.Header().Set("Content-Type", "text/event-stream")
					if present {
						fmt.Fprintln(w, `data: {"id":"test","object":"chat.completion.chunk","model":"deployment-alias","choices":[{"index":0,"delta":{"reasoning_content":"inspect"}}]}`)
						fmt.Fprintln(w)
					}
					fmt.Fprintln(w, `data: {"id":"test","object":"chat.completion.chunk","model":"deployment-alias","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}`)
					fmt.Fprint(w, "\ndata: [DONE]\n\n")
				}))
				client, err := New(Config{Provider: provider, Model: "deployment-alias", Endpoint: serverURL, APIKey: "test-key"})
				if err != nil {
					t.Fatalf("New(): %v", err)
				}
				var text, reasoning strings.Builder
				var done bool
				result, err := client.Chat(context.Background(), llm.Request{
					Messages:         []llm.Message{{Role: "user", Content: "hello"}},
					ReasoningDetails: true,
					OnStream: func(event llm.StreamEvent) error {
						text.WriteString(event.Delta)
						if event.ReasoningDelta != nil {
							reasoning.WriteString(event.ReasoningDelta.Delta)
						}
						done = done || event.Done
						return nil
					},
				})
				if err != nil {
					t.Fatalf("Chat(): %v", err)
				}
				wantReasoning := ""
				if present {
					wantReasoning = "inspect"
				}
				if reasoning.String() != wantReasoning {
					t.Fatalf("reasoning = %q, want %q", reasoning.String(), wantReasoning)
				}
				if !done || text.String() != "answer" || result.Text != "answer" {
					t.Fatalf("done=%v streamed text=%q result text=%q", done, text.String(), result.Text)
				}
			})
		}
	}
}

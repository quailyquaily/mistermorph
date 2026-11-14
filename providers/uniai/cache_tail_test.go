package uniai

import (
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

func TestMarkConversationTail(t *testing.T) {
	short := &llm.CacheControl{TTL: "short"}
	marked := func(role, text string) llm.Message {
		return llm.Message{Role: role, Content: text, Parts: []llm.Part{{Type: llm.PartTypeText, Text: text, CacheControl: short}}}
	}
	plain := func(role, text string) llm.Message { return llm.Message{Role: role, Content: text} }
	marks := func(req llm.Request) (n int) {
		for _, m := range req.Messages {
			for _, p := range m.Parts {
				if p.CacheControl != nil {
					n++
				}
			}
		}
		return n
	}
	tail := func(req llm.Request) *llm.CacheControl {
		last := req.Messages[len(req.Messages)-1]
		for _, p := range last.Parts {
			if p.CacheControl != nil {
				return p.CacheControl
			}
		}
		return nil
	}

	t.Run("a tool loop's newest result is marked, and the request given is left as it was", func(t *testing.T) {
		req := llm.Request{Messages: []llm.Message{
			marked("system", "rules"), marked("assistant", "last history"), plain("user", "meta"), plain("user", "current"),
			{Role: "assistant", ToolCalls: []llm.ToolCall{{ID: "c1", Name: "bash"}}},
			{Role: "tool", ToolCallID: "c1", Content: "output"},
		}}
		got := markConversationTail(req)
		if marks(got) != 3 || tail(got) == nil || tail(got).TTL != "short" || tail(got) == short {
			t.Fatalf("marks=%d tail=%+v", marks(got), tail(got))
		}
		if last := got.Messages[len(got.Messages)-1]; last.Role != "tool" || last.ToolCallID != "c1" || last.Parts[0].Text != "output" {
			t.Fatalf("tool message changed: %+v", last)
		}
		if marks(req) != 2 || len(req.Messages[5].Parts) != 0 {
			t.Fatal("the caller's request was changed")
		}
	})
	t.Run("the first step marks the current message", func(t *testing.T) {
		got := markConversationTail(llm.Request{Messages: []llm.Message{marked("system", "rules"), plain("user", "meta"), plain("user", "current")}})
		if marks(got) != 2 || tail(got) == nil {
			t.Fatalf("marks=%d", marks(got))
		}
	})
	for name, req := range map[string]llm.Request{
		"caching off: no marks to go by":   {Messages: []llm.Message{plain("system", "rules"), plain("user", "current")}},
		"the last message is marked":       {Messages: []llm.Message{marked("system", "rules"), marked("user", "last history")}},
		"no room for another mark":         {Messages: []llm.Message{marked("system", "a"), marked("user", "b"), marked("user", "c"), marked("user", "d"), plain("user", "current")}},
		"only a system prompt":             {Messages: []llm.Message{marked("system", "rules")}},
		"a last message with nothing said": {Messages: []llm.Message{marked("system", "rules"), {Role: "assistant", ToolCalls: []llm.ToolCall{{ID: "c1", Name: "bash"}}}}},
	} {
		t.Run(name, func(t *testing.T) {
			before := marks(req)
			if got := markConversationTail(req); marks(got) != before {
				t.Fatalf("marks %d -> %d", before, marks(got))
			}
		})
	}
	t.Run("only Anthropic gets it", func(t *testing.T) {
		req := llm.Request{Messages: []llm.Message{marked("system", "rules"), plain("user", "current")}}
		if got := adaptRequestForProvider(req, "anthropic", "claude-opus-5-5", "short"); marks(got) != 2 {
			t.Fatalf("anthropic marks = %d", marks(got))
		}
		for _, provider := range []string{"openai", "openai_resp", "openai_codex", "bedrock", "gemini"} {
			if got := adaptRequestForProvider(req, provider, "gpt-6-astra", "short"); tail(got) != nil {
				t.Fatalf("%s: the last message was marked", provider)
			}
		}
	})
}

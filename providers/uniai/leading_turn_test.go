package uniai

import (
	"reflect"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	uniaichat "github.com/quailyquaily/uniai/chat"
)

func TestEnsureLeadingUserTurn(t *testing.T) {
	leading := []llm.Message{
		{Role: "system", Content: "sys"},
		{Role: "assistant", Content: "reminder"},
		{Role: "user", Content: "thanks"},
	}
	cases := []struct {
		name     string
		provider string
		messages []llm.Message
		want     []string
	}{
		{name: "anthropic leading assistant", provider: "anthropic", messages: leading, want: []string{"system", "user", "assistant", "user"}},
		{name: "bedrock leading assistant", provider: "bedrock", messages: leading, want: []string{"system", "user", "assistant", "user"}},
		{name: "openai leading assistant unchanged", provider: "openai", messages: leading, want: []string{"system", "assistant", "user"}},
		{name: "anthropic user first unchanged", provider: "anthropic", messages: []llm.Message{{Role: "system", Content: "sys"}, {Role: "user", Content: "hi"}}, want: []string{"system", "user"}},
		{name: "anthropic without system", provider: "Anthropic", messages: []llm.Message{{Role: "assistant", Content: "reminder"}, {Role: "user", Content: "ok"}}, want: []string{"user", "assistant", "user"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			original := append([]llm.Message(nil), tc.messages...)
			got := ensureLeadingUserTurn(llm.Request{Messages: tc.messages}, tc.provider)
			var roles []string
			for _, m := range got.Messages {
				roles = append(roles, m.Role)
			}
			if !reflect.DeepEqual(roles, tc.want) {
				t.Fatalf("roles = %v, want %v", roles, tc.want)
			}
			if !reflect.DeepEqual(tc.messages, original) {
				t.Fatal("caller messages were modified")
			}
		})
	}
}

func TestBuildChatOptionsAddsLeadingUserTurnForAnthropic(t *testing.T) {
	client := &Client{provider: "anthropic", model: "claude-opus-5"}
	opts := client.buildChatOptions(llm.Request{Messages: []llm.Message{
		{Role: "system", Content: "sys"},
		{Role: "assistant", Content: "reminder"},
		{Role: "user", Content: "thanks"},
	}}, false)
	built, err := uniaichat.BuildRequest(opts...)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if len(built.Messages) != 4 || built.Messages[1].Role != "user" || built.Messages[2].Role != "assistant" {
		t.Fatalf("messages = %+v, want a user turn before the leading assistant", built.Messages)
	}
}

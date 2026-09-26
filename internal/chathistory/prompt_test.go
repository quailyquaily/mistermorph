package chathistory

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestRenderHistoryMessagesRolesAndStablePrefix(t *testing.T) {
	items := []ChatHistoryItem{
		{Kind: KindInboundUser, Text: "question", MessageID: "1"},
		{Kind: KindOutboundAgent, Text: "answer", MessageID: "2"},
		{Kind: KindInboundUser, Text: "external bot", Sender: ChatHistorySender{IsBot: true}},
		{Kind: KindOutboundReaction, Text: "👍"},
		{Kind: KindSystem, Text: "joined"},
	}
	first := RenderHistoryMessages(items)
	second := RenderHistoryMessages(append(items, ChatHistoryItem{Kind: KindInboundUser, Text: "next"}))
	if len(first) != len(items) || !reflect.DeepEqual(first, second[:len(first)]) {
		t.Fatal("history prefix changed")
	}
	for i, want := range []string{"user", "assistant", "user", "user", "user"} {
		if first[i].Role != want {
			t.Fatalf("role[%d] = %s, want %s", i, first[i].Role, want)
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(first[i].Content), &payload); err != nil {
			t.Fatal(err)
		}
		if want == "assistant" {
			// The agent's own replies take its response shape, so the model does not copy a
			// history record as its answer.
			if !reflect.DeepEqual(payload, map[string]any{"type": "final", "output": items[i].Text}) {
				t.Fatalf("assistant payload = %#v, want final response shape", payload)
			}
			continue
		}
		if payload["text"] != items[i].Text || payload["note"] != nil || payload["historical_message"] != nil || payload["type"] != nil {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	}
	if len(RenderHistoryMessages(nil)) != 0 {
		t.Fatal("empty history rendered a message")
	}
}

func TestRenderHistoryContext(t *testing.T) {
	t.Parallel()

	raw := RenderHistoryContext([]ChatHistoryItem{{
		Kind:      KindInboundUser,
		MessageID: "101",
		SentAt:    time.Date(2026, 3, 8, 9, 0, 0, 0, time.UTC),
		Text:      "earlier message",
	}})
	var payload struct {
		ChatHistoryMessages []PromptMessageItem `json:"chat_history_messages"`
		Note                string              `json:"note"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if len(payload.ChatHistoryMessages) != 1 {
		t.Fatalf("len(chat_history_messages) = %d, want 1", len(payload.ChatHistoryMessages))
	}
	if payload.ChatHistoryMessages[0].Text != "earlier message" {
		t.Fatalf("text = %q, want %q", payload.ChatHistoryMessages[0].Text, "earlier message")
	}
	if !strings.Contains(payload.Note, "Historical messages only") {
		t.Fatalf("note = %q, want historical-context guidance", payload.Note)
	}
	var rawPayload map[string]any
	if err := json.Unmarshal([]byte(raw), &rawPayload); err != nil {
		t.Fatalf("Unmarshal(raw map) error = %v", err)
	}
	itemsRaw, ok := rawPayload["chat_history_messages"].([]any)
	if !ok || len(itemsRaw) != 1 {
		t.Fatalf("raw chat_history_messages shape = %#v", rawPayload["chat_history_messages"])
	}
	itemRaw, ok := itemsRaw[0].(map[string]any)
	if !ok {
		t.Fatalf("raw item shape = %#v", itemsRaw[0])
	}
	for _, field := range []string{"channel", "kind", "chat_id", "chat_type", "message_id", "reply_to_message_id"} {
		if _, exists := itemRaw[field]; exists {
			t.Fatalf("field %q should be omitted from prompt item", field)
		}
	}
}

func TestRenderHistoryContextEmptyReturnsBlank(t *testing.T) {
	t.Parallel()

	raw := RenderHistoryContext(nil)
	if raw != "" {
		t.Fatalf("raw = %q, want blank", raw)
	}
}

func TestRenderCurrentMessage(t *testing.T) {
	t.Parallel()

	raw := RenderCurrentMessage(ChatHistoryItem{
		Channel:   ChannelSlack,
		Kind:      KindInboundUser,
		MessageID: "102",
		SentAt:    time.Date(2026, 3, 8, 9, 2, 0, 0, time.UTC),
		Text:      "Hi",
	})
	var payload struct {
		CurrentMessage PromptMessageItem `json:"current_message"`
		Instruction    string            `json:"instruction"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if payload.CurrentMessage.Text != "Hi" {
		t.Fatalf("text = %q, want %q", payload.CurrentMessage.Text, "Hi")
	}
	if !strings.Contains(payload.Instruction, "latest inbound user message") {
		t.Fatalf("instruction = %q, want latest-message guidance", payload.Instruction)
	}
	var rawPayload map[string]any
	if err := json.Unmarshal([]byte(raw), &rawPayload); err != nil {
		t.Fatalf("Unmarshal(raw map) error = %v", err)
	}
	itemRaw, ok := rawPayload["current_message"].(map[string]any)
	if !ok {
		t.Fatalf("raw current_message shape = %#v", rawPayload["current_message"])
	}
	for _, field := range []string{"channel", "kind", "chat_id", "chat_type", "message_id", "reply_to_message_id"} {
		if _, exists := itemRaw[field]; exists {
			t.Fatalf("field %q should be omitted from current_message", field)
		}
	}
}

func TestRenderCurrentMessageIncludesImages(t *testing.T) {
	t.Parallel()

	raw := RenderCurrentMessage(ChatHistoryItem{
		Channel:   ChannelSlack,
		Kind:      KindInboundUser,
		MessageID: "102",
		SentAt:    time.Date(2026, 3, 8, 9, 2, 0, 0, time.UTC),
		Text:      "look",
		Images: []ChatHistoryImage{{
			ID:                 "img_abc123",
			Path:               "workspace_dir/.mistermorph/images/slack/a.png",
			MIMEType:           "image/png",
			Width:              2,
			Height:             3,
			Bytes:              79,
			ContentSHA256:      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			SourceMessageID:    "1739667600.000100",
			SourceAttachmentID: "F111",
			Description:        "a small test image",
			DescriptionSource:  "agent_final",
		}},
	})
	var payload struct {
		CurrentMessage PromptMessageItem `json:"current_message"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if len(payload.CurrentMessage.Images) != 1 {
		t.Fatalf("images len = %d, want 1", len(payload.CurrentMessage.Images))
	}
	img := payload.CurrentMessage.Images[0]
	if img.ID != "img_abc123" || img.Path != "workspace_dir/.mistermorph/images/slack/a.png" {
		t.Fatalf("image identity mismatch: %#v", img)
	}
	if img.Width != 2 || img.Height != 3 || img.Bytes != 79 {
		t.Fatalf("image metadata mismatch: %#v", img)
	}
	if img.ContentSHA256 != "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" {
		t.Fatalf("image content hash mismatch: %#v", img)
	}
	if img.Description != "a small test image" || img.DescriptionSource != "agent_final" {
		t.Fatalf("image description mismatch: %#v", img)
	}
}

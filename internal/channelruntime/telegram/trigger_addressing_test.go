package telegram

import (
	"context"
	"errors"
	"fmt"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"testing"
)

type stubAddressingLLMClient struct {
	addressed bool
	response  string
	calls     []llm.EvaluateRequest
}

func (s *stubAddressingLLMClient) Chat(context.Context, llm.Request) (llm.Result, error) {
	panic("unexpected Chat")
}
func (s *stubAddressingLLMClient) Evaluate(_ context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	s.calls = append(s.calls, req)
	yes := true
	score := 9.0
	selected := s.response
	if selected == "" {
		for key, value := range req.Questions["response"].Options {
			if value == "🤨" {
				selected = key
			}
		}
	}
	return &llm.EvaluateResult{Emulated: true, Answers: map[string]llm.Answer{
		"addressed":       {Kind: llm.Boolean, BooleanValue: &s.addressed},
		"wanna_interject": {Kind: llm.Boolean, BooleanValue: &yes},
		"confidence":      {Kind: llm.Score, ScoreValue: &score}, "interject": {Kind: llm.Score, ScoreValue: &score}, "impulse": {Kind: llm.Score, ScoreValue: &score},
		"response": {Kind: llm.Choice, Selected: selected},
	}}, nil
}

type stubAddressingTool struct {
	name        string
	execCount   int
	lastEmoji   string
	failOnEmoji string
}

func (s *stubAddressingTool) Name() string            { return s.name }
func (s *stubAddressingTool) Description() string     { return "stub" }
func (s *stubAddressingTool) ParameterSchema() string { return "{}" }
func (s *stubAddressingTool) Execute(_ context.Context, p map[string]any) (string, error) {
	s.execCount++
	s.lastEmoji, _ = p["emoji"].(string)
	if s.lastEmoji == s.failOnEmoji {
		return "", fmt.Errorf("send failed")
	}
	return "ok", nil
}

func TestAddressingEvaluationDoesNotSendReaction(t *testing.T) {
	c := &stubAddressingLLMClient{addressed: true}
	tool := &stubAddressingTool{name: "message_react"}
	got, ok, err := addressingDecisionViaLLM(context.Background(), c, "judge", nil, "Hi", nil, tool)
	if err != nil || !ok || !got.IsLightweight || got.Reaction != "🤨" || tool.execCount != 0 || len(c.calls) != 1 {
		t.Fatalf("got=%+v ok=%v err=%v sends=%d", got, ok, err, tool.execCount)
	}
}

func TestAddressingEvaluationReactionAvailability(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("enabled=%v", enabled), func(t *testing.T) {
			client := &stubAddressingLLMClient{addressed: true, response: "text"}
			var tool tools.Tool
			if enabled {
				tool = &stubAddressingTool{name: "message_react"}
			}
			got, ok, err := addressingDecisionViaLLM(context.Background(), client, "judge", nil, "Hi", nil, tool)
			if err != nil || !ok || got.IsLightweight || len(client.calls) != 1 {
				t.Fatalf("got=%+v ok=%v err=%v calls=%d", got, ok, err, len(client.calls))
			}
			options := client.calls[0].Questions["response"].Options
			if !enabled && len(options) != 1 {
				t.Fatalf("reaction offered without a tool: %v", options)
			}
			if enabled && options["reaction_0"] != "👍" {
				t.Fatalf("missing first allowed reaction: %v", options)
			}
		})
	}
}

func TestGroupDecisionReactionGate(t *testing.T) {
	for _, tt := range []struct {
		name      string
		addressed bool
		response  string
		fail      bool
		sends     int
		handled   bool
		wantErr   bool
	}{
		{"reaction", true, "", false, 1, true, false},
		{"ignored", false, "", false, 0, false, false},
		{"text", true, "text", false, 0, false, false},
		{"invalid", true, "bad-option", false, 0, false, true},
		{"failed send", true, "", true, 1, false, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c := &stubAddressingLLMClient{addressed: tt.addressed, response: tt.response}
			tool := &stubAddressingTool{name: "message_react"}
			if tt.fail {
				tool.failOnEmoji = "🤨"
			}
			got, accepted, err := groupTriggerDecision(context.Background(), c, "judge", &telegramMessage{MessageID: 10, Text: "Hi"}, "bot", 99, "smart", 0, .6, .6, nil, tool)
			if (err != nil) != tt.wantErr || got.ReactionHandled != tt.handled || tool.execCount != tt.sends {
				t.Fatalf("decision=%+v err=%v sends=%d", got, err, tool.execCount)
			}
			if tt.wantErr && accepted {
				t.Fatal("failed decision accepted")
			}
			if tt.response == "bad-option" && !errors.Is(err, llm.ErrEvaluateInvalidResponse) {
				t.Fatal(err)
			}
		})
	}
}

func TestShouldSkipGroupReplyWithoutBodyMention_IgnoresForumTopicRootReply(t *testing.T) {
	msg := &telegramMessage{
		Text: "hi",
		From: &telegramUser{ID: 10},
		ReplyTo: &telegramMessage{
			MessageID:         246,
			MessageThreadID:   246,
			IsTopicMessage:    true,
			ForumTopicCreated: []byte(`{"name":"topic"}`),
			From:              &telegramUser{ID: 20, Username: "topic_creator"},
		},
	}

	if shouldSkipGroupReplyWithoutBodyMention(msg, "hi", "morph_bot", 99) {
		t.Fatalf("topic root reply should not be treated as replying to another user")
	}
}

func TestShouldSkipGroupReplyWithoutBodyMention_SkipsHumanReplyWithoutMention(t *testing.T) {
	msg := &telegramMessage{
		Text:    "hi",
		From:    &telegramUser{ID: 10},
		ReplyTo: &telegramMessage{MessageID: 42, From: &telegramUser{ID: 20, Username: "alice"}},
	}

	if !shouldSkipGroupReplyWithoutBodyMention(msg, "hi", "morph_bot", 99) {
		t.Fatalf("plain human reply without bot mention should be skipped")
	}
}

func TestGroupExplicitMentionReason_IgnoresForumTopicRootReplyFromBot(t *testing.T) {
	msg := &telegramMessage{
		Text: "hi",
		ReplyTo: &telegramMessage{
			MessageID:         246,
			MessageThreadID:   246,
			IsTopicMessage:    true,
			ForumTopicCreated: []byte(`{"name":"topic"}`),
			From:              &telegramUser{ID: 99, IsBot: true, Username: "morph_bot"},
		},
	}

	if reason, ok := groupExplicitMentionReason(msg, "hi", "morph_bot", 99); ok {
		t.Fatalf("topic root reply should not count as explicit bot reply: reason=%q", reason)
	}
}

func TestCollectMentionCandidates_IgnoresForumTopicRootReplySender(t *testing.T) {
	msg := &telegramMessage{
		Text: "hi",
		From: &telegramUser{ID: 10, Username: "sender"},
		ReplyTo: &telegramMessage{
			MessageID:         246,
			MessageThreadID:   246,
			IsTopicMessage:    true,
			ForumTopicCreated: []byte(`{"name":"topic"}`),
			From:              &telegramUser{ID: 20, Username: "topic_creator"},
		},
	}

	got := collectMentionCandidates(msg, "morph_bot")
	if len(got) != 1 || got[0] != "@sender" {
		t.Fatalf("mention candidates = %#v, want [@sender]", got)
	}
}

func TestTelegramFirstBodyMentionTargetsSelf(t *testing.T) {
	tests := []struct {
		name       string
		message    *telegramMessage
		wantFound  bool
		wantTarget bool
	}{
		{
			name: "username mention targets self",
			message: &telegramMessage{
				Text:     "@morph_bot please continue",
				Entities: []telegramEntity{{Type: "mention", Offset: 0, Length: 10}},
			},
			wantFound:  true,
			wantTarget: true,
		},
		{
			name: "first mention targets another agent",
			message: &telegramMessage{
				Text: "@smith_bot then @morph_bot",
				Entities: []telegramEntity{
					{Type: "mention", Offset: 16, Length: 10},
					{Type: "mention", Offset: 0, Length: 10},
				},
			},
			wantFound: true,
		},
		{
			name: "text mention user id targets self",
			message: &telegramMessage{
				Text:     "Morph please continue",
				Entities: []telegramEntity{{Type: "text_mention", Offset: 0, Length: 5, User: &telegramUser{ID: 99}}},
			},
			wantFound:  true,
			wantTarget: true,
		},
		{
			name: "caption mention",
			message: &telegramMessage{
				Caption:         "@morph_bot inspect this",
				CaptionEntities: []telegramEntity{{Type: "mention", Offset: 0, Length: 10}},
			},
			wantFound:  true,
			wantTarget: true,
		},
		{name: "no mention", message: &telegramMessage{Text: "plain task"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			found, targetsSelf := telegramFirstBodyMentionTargetsSelf(tt.message, "morph_bot", 99)
			if found != tt.wantFound || targetsSelf != tt.wantTarget {
				t.Fatalf("telegramFirstBodyMentionTargetsSelf() = (%v, %v), want (%v, %v)", found, targetsSelf, tt.wantFound, tt.wantTarget)
			}
		})
	}
}

func TestShouldIgnoreTelegramFirstMention(t *testing.T) {
	tests := []struct {
		name        string
		isGroup     bool
		fromAgent   bool
		found       bool
		targetsSelf bool
		want        bool
	}{
		{name: "private agent without mention", fromAgent: true},
		{name: "private agent mentioning another agent", fromAgent: true, found: true},
		{name: "group agent without mention", isGroup: true, fromAgent: true, want: true},
		{name: "group agent mentioning self", isGroup: true, fromAgent: true, found: true, targetsSelf: true},
		{name: "group agent mentioning another agent", isGroup: true, fromAgent: true, found: true, want: true},
		{name: "group human without mention", isGroup: true},
		{name: "group human mentioning another agent", isGroup: true, found: true, want: true},
		{name: "private human mentioning another agent", found: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shouldIgnoreTelegramFirstMention(tt.isGroup, tt.fromAgent, tt.found, tt.targetsSelf)
			if got != tt.want {
				t.Fatalf("shouldIgnoreTelegramFirstMention() = %v, want %v", got, tt.want)
			}
		})
	}
}

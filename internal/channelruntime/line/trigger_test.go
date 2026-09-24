package line

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	linebus "github.com/quailyquaily/mistermorph/internal/bus/adapters/line"
	"github.com/quailyquaily/mistermorph/llm"
)

type stubLineAddressingLLMClient struct {
	results []llm.Result
	err     error
}

func (s *stubLineAddressingLLMClient) Chat(context.Context, llm.Request) (llm.Result, error) {
	panic("unexpected Chat")
}
func (s *stubLineAddressingLLMClient) Evaluate(_ context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	if s.err != nil {
		return nil, s.err
	}
	if len(s.results) == 0 {
		return nil, fmt.Errorf("no stub result")
	}
	// Existing behavioral fixtures are translated to native Evaluate answers.
	var value struct {
		Addressed      bool
		Confidence     float64
		WannaInterject bool `json:"wanna_interject"`
		Interject      float64
		Impulse        float64
	}
	if err := json.Unmarshal([]byte(s.results[0].Text), &value); err != nil {
		return nil, err
	}
	s.results = s.results[1:]
	addressed, wanna := 0.0, 0.0
	if value.Addressed {
		addressed = 1
	}
	if value.WannaInterject {
		wanna = 1
	}
	confidence, interject, impulse := value.Confidence*9, value.Interject*9, value.Impulse*9
	if len(req.Questions["response"].Options) != 1 {
		return nil, fmt.Errorf("LINE must not offer reactions")
	}
	return &llm.EvaluateResult{Answers: map[string]llm.Answer{
		"addressed": {Kind: llm.Boolean, ProbabilityTrue: &addressed}, "wanna_interject": {Kind: llm.Boolean, ProbabilityTrue: &wanna},
		"confidence": {Kind: llm.Score, ScoreValue: &confidence}, "interject": {Kind: llm.Score, ScoreValue: &interject}, "impulse": {Kind: llm.Score, ScoreValue: &impulse},
		"response": {Kind: llm.Choice, Selected: "text"},
	}}, nil
}

func TestLineExplicitTriggerReason(t *testing.T) {
	t.Parallel()

	reason, ok := lineExplicitTriggerReason(linebus.InboundMessage{
		Text:         "hello",
		MentionUsers: []string{"Ubot001"},
	}, "Ubot001")
	if !ok || reason != "mention" {
		t.Fatalf("mention explicit = (%q,%v), want (mention,true)", reason, ok)
	}

	reason, ok = lineExplicitTriggerReason(linebus.InboundMessage{
		Text: "/help",
	}, "Ubot001")
	if !ok || reason != "command_prefix" {
		t.Fatalf("command explicit = (%q,%v), want (command_prefix,true)", reason, ok)
	}

	reason, ok = lineExplicitTriggerReason(linebus.InboundMessage{
		Text: "hello everyone",
	}, "Ubot001")
	if ok || reason != "" {
		t.Fatalf("non-explicit = (%q,%v), want (\"\",false)", reason, ok)
	}
}

func TestDecideLineGroupTriggerStrict(t *testing.T) {
	t.Parallel()

	inboundMention := linebus.InboundMessage{
		ChatType:     "group",
		Text:         "hello",
		MentionUsers: []string{"Ubot001"},
		FromUserID:   "U123",
		FromUsername: "alice",
		DisplayName:  "Alice",
		ChatID:       "Cgroup123",
		MessageID:    "m_1001",
		EventID:      "ev_1",
		ReplyToken:   "rtok_1",
	}
	dec, ok, err := decideLineGroupTrigger(nil, nil, "", inboundMention, "Ubot001", "strict", 0, 0.6, 0.6, nil)
	if err != nil {
		t.Fatalf("decideLineGroupTrigger(mention) error = %v", err)
	}
	if !ok {
		t.Fatalf("decideLineGroupTrigger(mention) ok=false, want true")
	}
	if dec.Addressing.Impulse != 1 {
		t.Fatalf("addressing impulse = %v, want 1", dec.Addressing.Impulse)
	}

	inboundIgnored := linebus.InboundMessage{
		ChatType:   "group",
		Text:       "hello everyone",
		FromUserID: "U123",
		ChatID:     "Cgroup123",
		MessageID:  "m_1002",
	}
	_, ok, err = decideLineGroupTrigger(nil, nil, "", inboundIgnored, "Ubot001", "strict", 0, 0.6, 0.6, nil)
	if err != nil {
		t.Fatalf("decideLineGroupTrigger(non_mention) error = %v", err)
	}
	if ok {
		t.Fatalf("decideLineGroupTrigger(non_mention) ok=true, want false")
	}
}

func TestDecideLineGroupTriggerSmart(t *testing.T) {
	t.Parallel()

	client := &stubLineAddressingLLMClient{
		results: []llm.Result{
			{Text: `{"addressed":true,"confidence":0.9,"wanna_interject":false,"interject":0.1,"impulse":0.5,"is_lightweight":false,"reason":"addressed"}`},
		},
	}
	inbound := linebus.InboundMessage{
		ChatType:   "group",
		Text:       "can you check this",
		ChatID:     "Cgroup123",
		MessageID:  "m_1001",
		FromUserID: "U123",
	}
	_, ok, err := decideLineGroupTrigger(context.Background(), client, "gpt-5.2", inbound, "Ubot001", "smart", 0, 0.6, 0.6, nil)
	if err != nil {
		t.Fatalf("decideLineGroupTrigger(smart) error = %v", err)
	}
	if !ok {
		t.Fatalf("decideLineGroupTrigger(smart) ok=false, want true")
	}
}

func TestDecideLineGroupTriggerTalkative(t *testing.T) {
	t.Parallel()

	client := &stubLineAddressingLLMClient{
		results: []llm.Result{
			{Text: `{"addressed":false,"confidence":0.3,"wanna_interject":true,"interject":0.9,"impulse":0.9,"is_lightweight":false,"reason":"interject"}`},
		},
	}
	inbound := linebus.InboundMessage{
		ChatType:   "group",
		Text:       "interesting topic",
		ChatID:     "Cgroup123",
		MessageID:  "m_1001",
		FromUserID: "U123",
	}
	_, ok, err := decideLineGroupTrigger(context.Background(), client, "gpt-5.2", inbound, "Ubot001", "talkative", 0, 0.6, 0.6, nil)
	if err != nil {
		t.Fatalf("decideLineGroupTrigger(talkative) error = %v", err)
	}
	if !ok {
		t.Fatalf("decideLineGroupTrigger(talkative) ok=false, want true")
	}
}

func TestLineAddressingDecisionViaLLM_UsesTextWithoutReactionTool(t *testing.T) {
	t.Parallel()

	client := &stubLineAddressingLLMClient{
		results: []llm.Result{
			{Text: `{"addressed":false,"confidence":0.2,"wanna_interject":true,"interject":0.2,"impulse":0.2,"is_lightweight":true,"reaction":"👍","reason":"x"}`},
		},
	}
	got, ok, err := lineAddressingDecisionViaLLM(context.Background(), client, "gpt-5.2", linebus.InboundMessage{
		ChatID:       "C123",
		ChatType:     "group",
		MessageID:    "m_1001",
		FromUserID:   "U1",
		Text:         "ok",
		ReplyToken:   "rtok",
		MentionUsers: nil,
	}, nil)
	if err != nil {
		t.Fatalf("lineAddressingDecisionViaLLM() error = %v", err)
	}
	if !ok {
		t.Fatalf("lineAddressingDecisionViaLLM() ok=false, want true")
	}
	if got.IsLightweight {
		t.Fatalf("IsLightweight = true, want false")
	}
}

package consolecmd

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/spf13/viper"
)

// suggestLLM answers the gate and scoring Evaluate calls and the proposal Chat call.
type suggestLLM struct {
	expects  bool
	emulated bool
	proposal string
	scores   map[string]float64
	chats    int
	requests []llm.Request
	evals    []llm.EvaluateRequest
}

func (s *suggestLLM) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	s.chats++
	s.requests = append(s.requests, req)
	return llm.Result{Text: s.proposal}, nil
}

func (s *suggestLLM) Evaluate(_ context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	s.evals = append(s.evals, req)
	out := &llm.EvaluateResult{Emulated: s.emulated, Answers: map[string]llm.Answer{}}
	for name := range req.Questions {
		p := s.scores[name]
		if name == "expects_reply" {
			p = 0.1
			if s.expects {
				p = 0.9
			}
		}
		if s.emulated {
			v := p > 0.5
			out.Answers[name] = llm.Answer{Kind: llm.Boolean, BooleanValue: &v}
		} else {
			out.Answers[name] = llm.Answer{Kind: llm.Boolean, ProbabilityTrue: &p}
		}
	}
	return out, nil
}

func TestSuggestRepliesStopsWhenTheAnswerAsksNothing(t *testing.T) {
	client := &suggestLLM{expects: false}
	out, err := suggestReplies(context.Background(), client, "m", "summarize this", "Here is the summary.")
	if err != nil {
		t.Fatal(err)
	}
	if out.ExpectsReply || len(out.Suggestions) != 0 || client.chats != 0 || len(client.evals) != 1 {
		t.Fatalf("out = %+v, chats = %d, evals = %d", out, client.chats, len(client.evals))
	}
}

func TestSuggestRepliesUsesProviderProbabilitiesWhenItHasThem(t *testing.T) {
	proposal := `{"replies":[{"text":"2","probability":0.5},{"text":"  1  ","probability":0.3},{"text":"1","probability":0.2},{"text":"","probability":0.9},{"text":"3","probability":0.1},{"text":"4","probability":0.1}]}`
	client := &suggestLLM{expects: true, proposal: proposal, scores: map[string]float64{"reply_0": 0.2, "reply_1": 0.7, "reply_2": 0.05}}
	out, err := suggestReplies(context.Background(), client, "m", "install it", "The preview failed. Say 1, 2, or 3.")
	if err != nil {
		t.Fatal(err)
	}
	// Blank and duplicate replies dropped, at most three, then re-ranked by the provider's probabilities.
	var got []string
	for _, s := range out.Suggestions {
		got = append(got, s.Text+"@"+s.ProbabilitySource)
	}
	if strings.Join(got, ",") != "1@evaluate,2@evaluate,3@evaluate" || out.Suggestions[0].Probability != 0.7 {
		t.Fatalf("suggestions = %+v", out.Suggestions)
	}
	// The proposal call has no tools and sees the conversation as data.
	req := client.requests[0]
	if len(req.Tools) != 0 || !req.ForceJSON || !strings.Contains(req.Messages[0].Content, "untrusted data") || !strings.Contains(req.Messages[1].Content, "Say 1, 2, or 3.") {
		t.Fatalf("proposal request = %+v", req)
	}
}

func TestSuggestRepliesKeepsModelEstimatesWhenEvaluateIsEmulated(t *testing.T) {
	client := &suggestLLM{expects: true, emulated: true, proposal: `{"replies":[{"text":"Yes, go ahead","probability":0.8},{"text":"No","probability":1.7}]}`}
	out, err := suggestReplies(context.Background(), client, "m", "q", "Shall I?")
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Suggestions) != 2 || out.Suggestions[0].Text != "No" || out.Suggestions[0].Probability != 1 || out.Suggestions[0].ProbabilitySource != "model" {
		t.Fatalf("suggestions = %+v", out.Suggestions)
	}
}

func TestReplySuggestionsAreOffUntilEnabled(t *testing.T) {
	reader := viper.New()
	gen := &consoleLocalRuntimeGeneration{reader: reader}
	resp, err := (&consoleLocalRuntime{}).replySuggestions(context.Background(), gen, "t1")
	if err != nil || resp.Enabled || resp.MinProbability != defaultReplySuggestionMinProbability || resp.Suggestions == nil {
		t.Fatalf("disabled = %+v, %v", resp, err)
	}
	reader.Set("console.reply_suggestions.enabled", true)
	reader.Set("console.reply_suggestions.min_probability", 1.5)
	if enabled, minP := replySuggestionSettings(gen); !enabled || minP != 1 {
		t.Fatalf("settings = %v, %v", enabled, minP)
	}
}

func TestReplySuggestionStateKeepsTheEndOfLongAnswers(t *testing.T) {
	answer := strings.Repeat("x", replySuggestionAnswerRunes) + " Say 1, 2, or 3."
	state := replySuggestionState("hi", answer)
	if !strings.HasSuffix(state["assistant_message"], "Say 1, 2, or 3.") || !strings.HasPrefix(state["assistant_message"], "…") {
		t.Fatalf("state = %.60q…", state["assistant_message"])
	}
}

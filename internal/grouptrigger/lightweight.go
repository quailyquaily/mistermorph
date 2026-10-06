package grouptrigger

import (
	"context"
	_ "embed"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/prompttmpl"
	"github.com/quailyquaily/mistermorph/llm"
)

//go:embed prompts/lightweight_system.md
var lightweightSystemPromptTemplateSource string

var lightweightSystemPromptTemplate = prompttmpl.MustParse(
	"grouptrigger_lightweight_system",
	lightweightSystemPromptTemplateSource,
	nil,
)

// DefaultLightweightEmojis are offered on channels without native reactions, where the chosen
// emoji is sent as a normal message.
var DefaultLightweightEmojis = []string{"👍", "👌", "🙏", "❤️", "😊", "😂", "🎉", "🔥", "👀", "🤝", "✅", "👋"}

// LightweightOptions describe one lightweight check: whether a message addressed to the agent
// needs a text reply or only an emoji.
type LightweightOptions struct {
	Client          llm.Client
	Model           string
	Scene           string
	PersonaIdentity string
	CurrentMessage  any
	History         []chathistory.ChatHistoryItem
	// Emojis are the reactions the channel can deliver; empty means text only.
	Emojis []string
}

// DecideLightweight asks the decision route only the reply questions. It returns the chosen
// emoji, or "" when the message needs text.
func DecideLightweight(ctx context.Context, opts LightweightOptions) (string, error) {
	if opts.Client == nil {
		return "", llm.ErrEvaluateUnsupported
	}
	personaIdentity := strings.TrimSpace(opts.PersonaIdentity)
	if personaIdentity == "" {
		personaIdentity = AddressingPersonaFallback
	}
	systemPrompt, err := prompttmpl.Render(lightweightSystemPromptTemplate, addressingSystemPromptData{PersonaIdentity: personaIdentity})
	if err != nil {
		return "", err
	}
	userPrompt, err := prompttmpl.Render(addressingUserPromptTemplate, addressingUserPromptData{
		CurrentMessage:      opts.CurrentMessage,
		ChatHistoryMessages: chathistory.BuildPromptMessages(lastAddressingHistoryItems(opts.History, addressingHistoryMaxItems)),
	})
	if err != nil {
		return "", err
	}
	questions := replyQuestions(opts.Emojis)
	if questions == nil {
		return "", nil
	}
	prefixInstructions(questions, systemPrompt)
	res, err := llm.Evaluate(ctx, opts.Client, llm.EvaluateRequest{
		Model:     opts.Model,
		Scene:     opts.Scene,
		State:     userPrompt,
		Questions: questions,
	})
	if err != nil {
		return "", err
	}
	if err := validateAnswers(res, questions); err != nil {
		return "", err
	}
	return chosenEmoji(questions, res.Answers), nil
}

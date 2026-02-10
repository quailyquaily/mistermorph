package telegramcmd

import (
	_ "embed"
	"encoding/json"
	"text/template"

	"github.com/quailyquaily/mistermorph/internal/prompttmpl"
	"github.com/quailyquaily/mistermorph/memory"
)

//go:embed prompts/memory_draft_system.tmpl
var memoryDraftSystemPromptTemplateSource string

//go:embed prompts/memory_draft_user.tmpl
var memoryDraftUserPromptTemplateSource string

var memoryPromptTemplateFuncs = template.FuncMap{
	"toJSON": func(v any) (string, error) {
		b, err := json.Marshal(v)
		if err != nil {
			return "", err
		}
		return string(b), nil
	},
}

var memoryDraftSystemPromptTemplate = prompttmpl.MustParse("telegram_memory_draft_system", memoryDraftSystemPromptTemplateSource, nil)
var memoryDraftUserPromptTemplate = prompttmpl.MustParse("telegram_memory_draft_user", memoryDraftUserPromptTemplateSource, memoryPromptTemplateFuncs)

type memoryDraftUserPromptData struct {
	SessionContext       MemoryDraftContext
	Conversation         []map[string]string
	ExistingSummaryItems []memory.SummaryItem
}

func renderMemoryDraftPrompts(
	ctxInfo MemoryDraftContext,
	conversation []map[string]string,
	existing memory.ShortTermContent,
) (string, string, error) {
	systemPrompt, err := prompttmpl.Render(memoryDraftSystemPromptTemplate, struct{}{})
	if err != nil {
		return "", "", err
	}
	userPrompt, err := prompttmpl.Render(memoryDraftUserPromptTemplate, memoryDraftUserPromptData{
		SessionContext:       ctxInfo,
		Conversation:         conversation,
		ExistingSummaryItems: existing.SummaryItems,
	})
	if err != nil {
		return "", "", err
	}
	return systemPrompt, userPrompt, nil
}

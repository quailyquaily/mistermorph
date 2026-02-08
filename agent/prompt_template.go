package agent

import (
	_ "embed"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/prompttmpl"
	"github.com/quailyquaily/mistermorph/tools"
)

//go:embed prompts/system.tmpl
var systemPromptTemplateSource string

var systemPromptTemplate = prompttmpl.MustParse("agent_system_prompt", systemPromptTemplateSource, nil)

type systemPromptTemplateBlock struct {
	Title   string
	Content string
}

type systemPromptTemplateData struct {
	Identity      string
	Blocks        []systemPromptTemplateBlock
	ToolSummaries string
	HasPlanCreate bool
	Rules         []string
}

func renderSystemPrompt(registry *tools.Registry, spec PromptSpec) (string, error) {
	data := systemPromptTemplateData{
		Identity: spec.Identity,
		Blocks:   make([]systemPromptTemplateBlock, 0, len(spec.Blocks)),
		Rules:    make([]string, 0, len(spec.Rules)),
	}
	for _, blk := range spec.Blocks {
		title := strings.TrimSpace(blk.Title)
		if title == "" {
			title = "Context"
		}
		data.Blocks = append(data.Blocks, systemPromptTemplateBlock{
			Title:   title,
			Content: strings.TrimSpace(blk.Content),
		})
	}
	for _, rule := range spec.Rules {
		rule = strings.TrimSpace(rule)
		if rule == "" {
			continue
		}
		data.Rules = append(data.Rules, rule)
	}
	if registry != nil {
		data.ToolSummaries = registry.FormatToolSummaries()
		_, data.HasPlanCreate = registry.Get("plan_create")
	}
	return prompttmpl.Render(systemPromptTemplate, data)
}

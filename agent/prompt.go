package agent

import (
	"strings"

	"github.com/quailyquaily/mistermorph/tools"
)

type PromptSpec struct {
	Identity string
	Rules    []string
	Blocks   []PromptBlock
}

type PromptBlock struct {
	Title   string
	Content string
}

func DefaultPromptSpec() PromptSpec {
	return PromptSpec{
		Identity: "You are MisterMorph, a general-purpose AI agent that can use tools to complete tasks.",
		Rules:    defaultSystemRules(),
	}
}

func BuildSystemPrompt(registry *tools.Registry, spec PromptSpec) string {
	rendered, err := renderSystemPrompt(registry, spec)
	if err == nil && strings.TrimSpace(rendered) != "" {
		return rendered
	}
	return buildSystemPromptLegacy(registry, spec)
}

func buildSystemPromptLegacy(registry *tools.Registry, spec PromptSpec) string {
	var b strings.Builder
	b.WriteString(spec.Identity)
	if len(spec.Blocks) > 0 {
		b.WriteString("\n\n## Skills & Context\n")
		b.WriteString("Skills are not tools. They provide extra context and may include scripts to run via tools like bash.\n\n")
		for _, blk := range spec.Blocks {
			title := strings.TrimSpace(blk.Title)
			if title == "" {
				title = "Context"
			}
			b.WriteString("### ")
			b.WriteString(title)
			b.WriteString("\n")
			b.WriteString(strings.TrimSpace(blk.Content))
			b.WriteString("\n\n")
		}
	}
	b.WriteString("\n\n## Available Tools\n")
	b.WriteString(registry.FormatToolSummaries())

	hasPlanCreate := false
	if registry != nil {
		_, hasPlanCreate = registry.Get("plan_create")
	}

	b.WriteString("## Response Format\n")
	if hasPlanCreate {
		b.WriteString("When not calling tools, you MUST respond with JSON in one of two formats:\n\n")
		b.WriteString("### Option 1: Plan\n")
		b.WriteString("```json\n")
		b.WriteString(`{
  "type": "plan",
  "plan": {
    "thought": "brief reasoning (optional)",
    "summary": "1-2 sentence overview",
    "steps": [
      {"step": "step 1", "status": "in_progress"},
      {"step": "step 2", "status": "pending"},
      {"step": "step 3", "status": "pending"}
    ],
    "risks": ["optional"],
    "questions": ["optional clarifying questions"],
    "completion": "what done looks like (optional)"
  }
}`)
		b.WriteString("\n```\n\n")
	} else {
		b.WriteString("When not calling tools, you MUST respond with JSON in the following format:\n\n")
	}

	if hasPlanCreate {
		b.WriteString("### Option 2: Final\n")
	} else {
		b.WriteString("### Final\n")
	}
	b.WriteString("```json\n")
	b.WriteString(`{
  "type": "final",
  "final": {
    "thought": "brief reasoning",
    "output": "your final answer"
  }
}`)
	b.WriteString("\n```\n\n")

	if len(spec.Rules) > 0 {
		b.WriteString("## Rules\n")
		for i, rule := range spec.Rules {
			b.WriteString(strings.TrimSpace(rule))
			if i < len(spec.Rules)-1 {
				b.WriteString("\n")
			}
		}
		b.WriteString("\n")
	}

	return b.String()
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/jsonutil"
	"github.com/quailyquaily/mistermorph/llm"
)

type planCreateTool struct {
	client       llm.Client
	defaultModel string
}

func newPlanCreateTool(client llm.Client, defaultModel string) *planCreateTool {
	return &planCreateTool{client: client, defaultModel: strings.TrimSpace(defaultModel)}
}

func (t *planCreateTool) Name() string { return "plan_create" }

func (t *planCreateTool) Description() string {
	return "Generate a concise execution plan for a task as JSON. Use when you want a plan before execution."
}

func (t *planCreateTool) ParameterSchema() string {
	s := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"task": map[string]any{
				"type":        "string",
				"description": "Task description to plan for.",
			},
			"max_steps": map[string]any{
				"type":        "integer",
				"description": "Maximum number of steps (default: 6).",
			},
			"style": map[string]any{
				"type":        "string",
				"description": "Optional style hint (e.g., terse, detailed).",
			},
			"model": map[string]any{
				"type":        "string",
				"description": "Optional model override for plan generation.",
			},
		},
		"required": []string{"task"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

type planCreateOutput struct {
	Summary   string   `json:"summary"`
	Steps     []string `json:"steps"`
	Risks     []string `json:"risks"`
	Questions []string `json:"questions"`
}

func (t *planCreateTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.client == nil {
		return "", fmt.Errorf("plan_create unavailable (missing llm client)")
	}
	task, _ := params["task"].(string)
	task = strings.TrimSpace(task)
	if task == "" {
		return "", fmt.Errorf("missing required param: task")
	}

	maxSteps := 6
	if v, ok := params["max_steps"]; ok {
		switch x := v.(type) {
		case int:
			if x > 0 {
				maxSteps = x
			}
		case int64:
			if x > 0 {
				maxSteps = int(x)
			}
		case float64:
			if x > 0 {
				maxSteps = int(x)
			}
		}
	}

	style, _ := params["style"].(string)
	style = strings.TrimSpace(style)

	model, _ := params["model"].(string)
	model = strings.TrimSpace(model)
	if model == "" {
		model = t.defaultModel
	}
	if model == "" {
		model = "gpt-4o-mini"
	}

	payload := map[string]any{
		"task":      task,
		"max_steps": maxSteps,
		"style":     style,
	}
	payloadJSON, _ := json.Marshal(payload)

	sys := strings.TrimSpace(`
You generate a concise execution plan.
Return ONLY JSON:
{
  "summary": "1-2 sentence overview",
  "steps": ["step 1", "step 2"],
  "risks": ["optional"],
  "questions": ["optional clarifying questions"]
}
Rules:
- Steps should be actionable and ordered.
- Keep within max_steps.
- If no questions, return an empty array.
`)

	res, err := t.client.Chat(ctx, llm.Request{
		Model:     model,
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: sys},
			{Role: "user", Content: string(payloadJSON)},
		},
		Parameters: map[string]any{
			"max_tokens": 400,
		},
	})
	if err != nil {
		return "", err
	}

	var out planCreateOutput
	if err := jsonutil.DecodeWithFallback(res.Text, &out); err != nil {
		return "", fmt.Errorf("invalid plan_create response")
	}

	out.Summary = strings.TrimSpace(out.Summary)
	if len(out.Steps) > maxSteps {
		out.Steps = out.Steps[:maxSteps]
	}

	b, _ := json.MarshalIndent(out, "", "  ")
	return string(b), nil
}

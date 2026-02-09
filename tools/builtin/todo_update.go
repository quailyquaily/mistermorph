package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/todo"
	"github.com/quailyquaily/mistermorph/llm"
)

type TodoUpdateTool struct {
	Enabled  bool
	WIPPath  string
	DONEPath string
	Contacts string
	Client   llm.Client
	Model    string
}

func NewTodoUpdateTool(enabled bool, wipPath string, donePath string, contactsDir string) *TodoUpdateTool {
	return NewTodoUpdateToolWithLLM(enabled, wipPath, donePath, contactsDir, nil, "")
}

func NewTodoUpdateToolWithLLM(enabled bool, wipPath string, donePath string, contactsDir string, client llm.Client, model string) *TodoUpdateTool {
	return &TodoUpdateTool{
		Enabled:  enabled,
		WIPPath:  strings.TrimSpace(wipPath),
		DONEPath: strings.TrimSpace(donePath),
		Contacts: strings.TrimSpace(contactsDir),
		Client:   client,
		Model:    strings.TrimSpace(model),
	}
}

func (t *TodoUpdateTool) BindLLM(client llm.Client, model string) {
	if t == nil {
		return
	}
	t.Client = client
	t.Model = strings.TrimSpace(model)
}

func (t *TodoUpdateTool) Name() string { return "todo_update" }

func (t *TodoUpdateTool) Description() string {
	return "Updates TODO files under file_state_dir. Supports add and complete actions, keeps counts in TODO.WIP.md/TODO.DONE.md consistent."
}

func (t *TodoUpdateTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{
				"type":        "string",
				"description": "Action: add|complete.",
			},
			"content": map[string]any{
				"type":        "string",
				"description": "Todo content. Required for add and complete.",
			},
		},
		"required": []string{"action", "content"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *TodoUpdateTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !t.Enabled {
		return "", fmt.Errorf("todo_update tool is disabled")
	}
	action, _ := params["action"].(string)
	action = strings.ToLower(strings.TrimSpace(action))
	content, _ := params["content"].(string)
	content = strings.TrimSpace(content)
	if action == "" {
		return "", fmt.Errorf("action is required")
	}
	if content == "" {
		return "", fmt.Errorf("content is required")
	}

	wipPath := pathutil.ExpandHomePath(strings.TrimSpace(t.WIPPath))
	donePath := pathutil.ExpandHomePath(strings.TrimSpace(t.DONEPath))
	contactsDir := pathutil.ExpandHomePath(strings.TrimSpace(t.Contacts))
	if wipPath == "" || donePath == "" {
		return "", fmt.Errorf("todo paths are not configured")
	}
	if contactsDir == "" {
		return "", fmt.Errorf("contacts dir is not configured")
	}
	if t.Client == nil {
		return "", fmt.Errorf("todo_update unavailable (missing llm client)")
	}
	if strings.TrimSpace(t.Model) == "" {
		return "", fmt.Errorf("todo_update unavailable (missing llm model)")
	}

	store := todo.NewStore(wipPath, donePath)
	store.Semantics = todo.NewLLMSemanticResolver(t.Client, t.Model)
	var (
		result todo.UpdateResult
		err    error
	)
	switch action {
	case "add":
		if _, preErr := todo.ExtractReferenceIDs(content); preErr != nil {
			return "", preErr
		}
		snapshot, snapErr := todo.LoadContactSnapshot(ctx, contactsDir)
		if snapErr != nil {
			return "", snapErr
		}
		resolver := todo.NewLLMReferenceResolver(t.Client, t.Model)
		rewritten, warnings, resolveErr := resolver.ResolveAddContent(ctx, content, snapshot)
		if resolveErr != nil {
			return "", resolveErr
		}
		if validErr := todo.ValidateReachableReferences(rewritten, snapshot); validErr != nil {
			return "", validErr
		}
		result, err = store.Add(ctx, rewritten)
		if err == nil && len(warnings) > 0 {
			result.Warnings = append(result.Warnings, warnings...)
		}
	case "complete":
		result, err = store.Complete(ctx, content)
	default:
		return "", fmt.Errorf("invalid action: %s", action)
	}
	if err != nil {
		return "", err
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return string(out), nil
}

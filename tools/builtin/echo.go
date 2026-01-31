package builtin

import (
	"context"
	"encoding/json"
	"fmt"
)

type EchoTool struct{}

func NewEchoTool() *EchoTool { return &EchoTool{} }

func (t *EchoTool) Name() string { return "echo" }

func (t *EchoTool) Description() string {
	return "Echoes the provided value back to the agent. Useful for debugging and string formatting."
}

func (t *EchoTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"value": map[string]any{"type": "string", "description": "Value to echo."},
		},
		"required": []string{"value"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *EchoTool) Execute(_ context.Context, params map[string]any) (string, error) {
	if v, ok := params["value"]; ok {
		if s, ok := v.(string); ok {
			return s, nil
		}
		return "", fmt.Errorf("param 'value' must be a string")
	}
	return "", fmt.Errorf("missing required param: value")
}

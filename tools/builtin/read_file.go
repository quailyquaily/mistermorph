package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
)

type ReadFileTool struct {
	MaxBytes int64
}

func NewReadFileTool(maxBytes int64) *ReadFileTool {
	return &ReadFileTool{MaxBytes: maxBytes}
}

func (t *ReadFileTool) Name() string { return "read_file" }

func (t *ReadFileTool) Description() string {
	return "Reads a local text file from disk and returns its content (truncated to a maximum size)."
}

func (t *ReadFileTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{"type": "string", "description": "File path to read."},
		},
		"required": []string{"path"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *ReadFileTool) Execute(_ context.Context, params map[string]any) (string, error) {
	path, _ := params["path"].(string)
	if path == "" {
		return "", fmt.Errorf("missing required param: path")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if t.MaxBytes > 0 && int64(len(data)) > t.MaxBytes {
		data = data[:t.MaxBytes]
	}
	return string(data), nil
}

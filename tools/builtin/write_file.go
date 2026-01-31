package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type WriteFileTool struct {
	Enabled        bool
	ConfirmEachRun bool
	MaxBytes       int
}

func NewWriteFileTool(enabled bool, confirmEachRun bool, maxBytes int) *WriteFileTool {
	if maxBytes <= 0 {
		maxBytes = 512 * 1024
	}
	return &WriteFileTool{
		Enabled:        enabled,
		ConfirmEachRun: confirmEachRun,
		MaxBytes:       maxBytes,
	}
}

func (t *WriteFileTool) Name() string { return "write_file" }

func (t *WriteFileTool) Description() string {
	return "Writes text content to a local file (overwrite or append)."
}

func (t *WriteFileTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{
				"type":        "string",
				"description": "File path to write (relative or absolute).",
			},
			"content": map[string]any{
				"type":        "string",
				"description": "Text content to write.",
			},
			"mode": map[string]any{
				"type":        "string",
				"description": "Write mode: overwrite|append (default: overwrite).",
			},
			"mkdirs": map[string]any{
				"type":        "boolean",
				"description": "If true, creates parent directories as needed.",
			},
		},
		"required": []string{"path", "content"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *WriteFileTool) Execute(_ context.Context, params map[string]any) (string, error) {
	if !t.Enabled {
		return "", fmt.Errorf("write_file tool is disabled (enable via config: tools.write_file.enabled=true)")
	}

	path, _ := params["path"].(string)
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("missing required param: path")
	}

	content, _ := params["content"].(string)
	if t.MaxBytes > 0 && len(content) > t.MaxBytes {
		return "", fmt.Errorf("content too large (%d bytes > %d max)", len(content), t.MaxBytes)
	}

	mode, _ := params["mode"].(string)
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = "overwrite"
	}

	mkdirs := false
	if v, ok := params["mkdirs"].(bool); ok {
		mkdirs = v
	}

	if t.ConfirmEachRun {
		ok, err := confirmOnTTY(fmt.Sprintf("Write file?\npath: %s\nbytes: %d\nmode: %s\n[y/N]: ", path, len(content), mode))
		if err != nil {
			return "", err
		}
		if !ok {
			return "aborted", nil
		}
	}

	if mkdirs {
		dir := filepath.Dir(path)
		if dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return "", err
			}
		}
	}

	var err error
	switch mode {
	case "overwrite":
		err = os.WriteFile(path, []byte(content), 0o644)
	case "append":
		f, openErr := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if openErr != nil {
			return "", openErr
		}
		_, err = f.WriteString(content)
		_ = f.Close()
	default:
		return "", fmt.Errorf("invalid mode: %s (expected overwrite|append)", mode)
	}
	if err != nil {
		return "", err
	}

	abs, _ := filepath.Abs(path)
	out, _ := json.MarshalIndent(map[string]any{
		"path":      path,
		"abs_path":  abs,
		"bytes":     len(content),
		"mode":      mode,
		"mkdirs":    mkdirs,
		"max_bytes": t.MaxBytes,
	}, "", "  ")
	return string(out), nil
}

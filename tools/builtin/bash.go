package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type BashTool struct {
	Enabled        bool
	ConfirmEachRun bool
	DefaultTimeout time.Duration
	MaxOutputBytes int
}

func NewBashTool(enabled bool, confirmEachRun bool, defaultTimeout time.Duration, maxOutputBytes int) *BashTool {
	if defaultTimeout <= 0 {
		defaultTimeout = 30 * time.Second
	}
	if maxOutputBytes <= 0 {
		maxOutputBytes = 256 * 1024
	}
	return &BashTool{
		Enabled:        enabled,
		ConfirmEachRun: confirmEachRun,
		DefaultTimeout: defaultTimeout,
		MaxOutputBytes: maxOutputBytes,
	}
}

func (t *BashTool) Name() string { return "bash" }

func (t *BashTool) Description() string {
	return "Runs a bash command in the local environment and returns stdout/stderr. Disabled by default for safety."
}

func (t *BashTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"cmd": map[string]any{
				"type":        "string",
				"description": "Bash command to execute.",
			},
			"cwd": map[string]any{
				"type":        "string",
				"description": "Optional working directory.",
			},
			"timeout_seconds": map[string]any{
				"type":        "number",
				"description": "Optional timeout override in seconds.",
			},
		},
		"required": []string{"cmd"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *BashTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !t.Enabled {
		return "", fmt.Errorf("bash tool is disabled (enable via config: tools.bash.enabled=true)")
	}

	cmdStr, _ := params["cmd"].(string)
	cmdStr = strings.TrimSpace(cmdStr)
	if cmdStr == "" {
		return "", fmt.Errorf("missing required param: cmd")
	}
	cwd, _ := params["cwd"].(string)
	cwd = strings.TrimSpace(cwd)

	timeout := t.DefaultTimeout
	if v, ok := params["timeout_seconds"]; ok {
		if secs, ok := asFloat64(v); ok && secs > 0 {
			timeout = time.Duration(secs * float64(time.Second))
		}
	}

	if t.ConfirmEachRun {
		ok, err := confirmOnTTY(fmt.Sprintf("Run bash command?\n%s\n[y/N]: ", cmdStr))
		if err != nil {
			return "", err
		}
		if !ok {
			return "aborted", nil
		}
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, "bash", "-lc", cmdStr)
	if cwd != "" {
		cmd.Dir = cwd
	}

	var stdout limitedBuffer
	var stderr limitedBuffer
	stdout.Limit = t.MaxOutputBytes
	stderr.Limit = t.MaxOutputBytes
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	exitCode := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else if runCtx.Err() != nil {
			return "", fmt.Errorf("bash timed out after %s", timeout)
		} else {
			return "", err
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "exit_code: %d\n", exitCode)
	fmt.Fprintf(&b, "stdout_truncated: %t\n", stdout.Truncated)
	fmt.Fprintf(&b, "stderr_truncated: %t\n", stderr.Truncated)
	b.WriteString("stdout:\n")
	b.WriteString(string(bytes.ToValidUTF8(stdout.Bytes(), []byte("\n[non-utf8 output]\n"))))
	b.WriteString("\n\nstderr:\n")
	b.WriteString(string(bytes.ToValidUTF8(stderr.Bytes(), []byte("\n[non-utf8 output]\n"))))

	if exitCode != 0 {
		return b.String(), fmt.Errorf("bash exited with code %d", exitCode)
	}
	return b.String(), nil
}

type limitedBuffer struct {
	Limit     int
	Truncated bool
	buf       bytes.Buffer
}

func (w *limitedBuffer) Write(p []byte) (int, error) {
	if w.Limit <= 0 {
		return w.buf.Write(p)
	}
	remaining := w.Limit - w.buf.Len()
	if remaining <= 0 {
		w.Truncated = true
		return len(p), nil
	}
	if len(p) <= remaining {
		return w.buf.Write(p)
	}
	_, _ = w.buf.Write(p[:remaining])
	w.Truncated = true
	return len(p), nil
}

func (w *limitedBuffer) Bytes() []byte {
	return w.buf.Bytes()
}

func asFloat64(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	default:
		return 0, false
	}
}

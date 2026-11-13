package coderusage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// CodexReadTimeout bounds a quota read: starting the app server and its answer.
const CodexReadTimeout = 15 * time.Second

// ReadCodexQuota asks the Codex app server (`codex app-server`, JSON-RPC over stdio) for the
// account's rate limits: initialize, then `account/rateLimits/read`. It reads no credentials and
// uses no quota. command is the codex executable; env, when not nil, its environment.
func ReadCodexQuota(ctx context.Context, command string, env []string) (Quota, error) {
	if strings.TrimSpace(command) == "" {
		return Quota{}, fmt.Errorf("codex executable not found")
	}
	ctx, cancel := context.WithTimeout(ctx, CodexReadTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, "app-server")
	if env != nil {
		cmd.Env = env
	}
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Quota{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Quota{}, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: 4096}
	if err := cmd.Start(); err != nil {
		return Quota{}, fmt.Errorf("start codex app-server: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	requests := []map[string]any{
		{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{
			"clientInfo": map[string]any{"name": "mistermorph", "version": "1"},
		}},
		{"jsonrpc": "2.0", "method": "initialized"},
		{"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": nil},
	}
	for _, request := range requests {
		line, _ := json.Marshal(request)
		if _, err := stdin.Write(append(line, '\n')); err != nil {
			return Quota{}, fmt.Errorf("codex app-server: %w", err)
		}
	}

	result, err := readCodexResponse(stdout, 2)
	if err != nil {
		if ctx.Err() != nil {
			return Quota{}, fmt.Errorf("codex app-server did not answer in %s", CodexReadTimeout)
		}
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			err = fmt.Errorf("%w; stderr: %s", err, detail)
		}
		return Quota{}, err
	}
	return ParseCodexRateLimits(result, time.Now())
}

// readCodexResponse reads JSON-RPC lines until the response with id, skipping notifications.
func readCodexResponse(r io.Reader, id int) (json.RawMessage, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var message struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil || message.ID == nil || *message.ID != id {
			continue
		}
		if message.Error != nil {
			return nil, fmt.Errorf("codex app-server: %s", strings.TrimSpace(message.Error.Message))
		}
		if len(message.Result) == 0 || string(message.Result) == "null" {
			return nil, fmt.Errorf("codex app-server: empty rate limits")
		}
		return message.Result, nil
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("codex app-server: %w", err)
	}
	return nil, errors.New("codex app-server closed without answering")
}

type limitedWriter struct {
	buf   *bytes.Buffer
	limit int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if room := w.limit - w.buf.Len(); room > 0 {
		w.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// FindCommand finds a coder's executable on PATH with pathExtra after it (tools.coder.path_extra),
// never in the current directory, and returns it with the environment to run it in.
func FindCommand(name string, pathExtra []string) (string, []string, error) {
	pathValue := os.Getenv("PATH")
	for _, dir := range pathExtra {
		if dir = strings.TrimSpace(dir); dir != "" {
			pathValue += string(os.PathListSeparator) + dir
		}
	}
	names := []string{name}
	if runtime.GOOS == "windows" {
		names = []string{name + ".exe", name + ".cmd", name + ".bat", name}
	}
	for _, dir := range filepath.SplitList(pathValue) {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		for _, candidate := range names {
			path := filepath.Join(dir, candidate)
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode()&0o111 != 0) {
				env := append(os.Environ(), "PATH="+pathValue)
				return path, env, nil
			}
		}
	}
	return "", nil, fmt.Errorf("%s executable not found in PATH", name)
}

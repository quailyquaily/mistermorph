package coderusage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// CodexReadTimeout bounds a read (the quota, the models): starting the app server and its answer.
const CodexReadTimeout = 15 * time.Second

// ReadCodexQuota asks the Codex app server (`codex app-server`, JSON-RPC over stdio) for the
// account's rate limits: initialize, then `account/rateLimits/read`. It reads no credentials and
// uses no quota. command is the codex executable; env, when not nil, its environment.
func ReadCodexQuota(ctx context.Context, command string, env []string) (Quota, error) {
	result, err := codexAppServerRead(ctx, command, env, "account/rateLimits/read", nil)
	if err != nil {
		return Quota{}, err
	}
	return ParseCodexRateLimits(result, time.Now())
}

// ReadCodexModels asks the Codex app server for the models the signed-in account can use
// (`model/list`, every page), in the CLI's own order: its default first. It reads no credentials
// and uses no quota. command is the codex executable; env, when not nil, its environment.
func ReadCodexModels(ctx context.Context, command string, env []string) ([]string, error) {
	var ids []string
	seen := map[string]bool{}
	cursor := ""
	// The CLI answers in one page today; the bound only stops a cursor that never ends.
	for page := 0; page < 20; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		result, err := codexAppServerRead(ctx, command, env, "model/list", params)
		if err != nil {
			return nil, err
		}
		var list struct {
			Data []struct {
				ID    string `json:"id"`
				Model string `json:"model"`
			} `json:"data"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(result, &list); err != nil {
			return nil, fmt.Errorf("codex app-server: unreadable model list: %w", err)
		}
		for _, item := range list.Data {
			// `model` is the name a request takes; `id` names the entry (the same today).
			id := strings.TrimSpace(item.Model)
			if id == "" {
				id = strings.TrimSpace(item.ID)
			}
			if id != "" && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		cursor = strings.TrimSpace(list.NextCursor)
		if cursor == "" {
			break
		}
	}
	if len(ids) == 0 {
		return nil, errors.New("codex app-server listed no models")
	}
	return ids, nil
}

// codexAppServerRead starts the Codex app server, initializes it, sends one request and returns
// its result. The server is stopped when the answer is read.
func codexAppServerRead(ctx context.Context, command string, env []string, method string, params any) (json.RawMessage, error) {
	if strings.TrimSpace(command) == "" {
		return nil, fmt.Errorf("codex executable not found")
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
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: 4096}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start codex app-server: %w", err)
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
		{"jsonrpc": "2.0", "id": 2, "method": method, "params": params},
	}
	for _, request := range requests {
		line, _ := json.Marshal(request)
		if _, err := stdin.Write(append(line, '\n')); err != nil {
			return nil, fmt.Errorf("codex app-server: %w", err)
		}
	}

	result, err := readCodexResponse(stdout, 2)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("codex app-server did not answer in %s", CodexReadTimeout)
		}
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			err = fmt.Errorf("%w; stderr: %s", err, detail)
		}
		return nil, err
	}
	return result, nil
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
			return nil, fmt.Errorf("codex app-server: empty answer")
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

package consolecmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

type consoleSendFileTool struct {
	hub                                     *consoleStreamHub
	store                                   *daemonruntime.ConsoleFileStore
	taskID, topicID, workspaceDir, cacheDir string
	// denyPaths is tools.read_file.deny_paths: files the agent may not read may not be sent either.
	denyPaths []string
}

func (*consoleSendFileTool) Name() string   { return "send_file" }
func (*consoleSendFileTool) Deferred() bool { return true }
func (*consoleSendFileTool) Description() string {
	return "Send a local file, image, photo, document or report as a downloadable attachment to the current Console Web conversation. Share files from workspace_dir or file_cache_dir. Images receive a preview."
}
func (*consoleSendFileTool) ParameterSchema() string {
	return `{"type":"object","additionalProperties":false,"properties":{"dir_name":{"type":"string","enum":["workspace_dir","file_cache_dir"],"description":"Allowed directory containing the file."},"path":{"type":"string","minLength":1,"description":"File path relative to dir_name. Non-empty regular files up to 64 MiB."}},"required":["dir_name","path"]}`
}
func (t *consoleSendFileTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	for key := range params {
		if key != "dir_name" && key != "path" {
			return "", fmt.Errorf("unknown parameter: %s", key)
		}
	}
	dirName, _ := params["dir_name"].(string)
	path, _ := params["path"].(string)
	var dir string
	switch dirName {
	case "workspace_dir":
		dir = t.workspaceDir
	case "file_cache_dir":
		dir = t.cacheDir
	default:
		return "", fmt.Errorf("dir_name must be workspace_dir or file_cache_dir")
	}
	if dir == "" {
		return "", fmt.Errorf("requested file directory is unavailable")
	}
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsLocal(path) {
		return "", fmt.Errorf("path must be a relative file path within dir_name")
	}
	// Check the path as named and, for a symlink, the file it points to, as read_file would.
	full := filepath.Join(dir, path)
	candidates := []string{full}
	if real, err := filepath.EvalSymlinks(full); err == nil && real != full {
		candidates = append(candidates, real)
	}
	for _, candidate := range candidates {
		if offending, denied := builtin.DeniedPath(candidate, t.denyPaths); denied {
			return "", fmt.Errorf("send_file denied for path %q (matched %q in tools.read_file.deny_paths)", path, offending)
		}
	}
	// Root.Open enforces the boundary during the open, including concurrent symlink changes.
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "", fmt.Errorf("cannot access requested file directory")
	}
	defer root.Close()
	info, err := root.Stat(path)
	if err != nil {
		return "", fmt.Errorf("file is missing, unreadable or outside the allowed directory")
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("file must be a regular file")
	}
	if info.Mode().Perm()&0o444 == 0 {
		return "", fmt.Errorf("file is unreadable")
	}
	file, err := root.Open(path)
	if err != nil {
		return "", fmt.Errorf("file is missing, unreadable or outside the allowed directory")
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("file must be a readable regular file")
	}
	attachment, err := t.store.AddAttachment(t.taskID, t.topicID, filepath.Base(path), file)
	if err != nil {
		return "", fmt.Errorf("send_file delivery failed: %w", err)
	}
	if t.hub != nil {
		if task, ok := t.store.Get(t.taskID); ok {
			t.hub.publish(consoleStreamFrame{TaskID: t.taskID, Attachments: task.Attachments})
		}
	}
	payload, err := json.Marshal(map[string]any{"sent": true, "attachment": attachment})
	return string(payload), err
}

func (s *server) handleReceivedAttachment(w http.ResponseWriter, r *http.Request) {
	if s.localRuntime == nil {
		writeError(w, http.StatusServiceUnavailable, "console is unavailable")
		return
	}
	s.localRuntime.store.ServeAttachment(w, r)
}

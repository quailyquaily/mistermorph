package consolecmd

import (
	"context"
	"encoding/json"
	"errors"
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
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "", fmt.Errorf("cannot access requested file directory")
	}
	defer root.Close()
	file, err := openAllowedFile(root, dir, path, t.denyPaths)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
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

// maxSendFileSymlinks bounds the symlinks openAllowedFile follows for one file.
const maxSendFileSymlinks = 16

var errSendFileChanged = errors.New("file changed while it was being opened; try again")

// openAllowedFile opens path under root unless tools.read_file.deny_paths denies it. It follows
// symlinks itself, one at a time, so every name it checks is the name of the file it opens; then
// it confirms the opened file is the one it checked. A symlink swapped between the check and the
// open therefore cannot deliver a denied file. root keeps every step inside dir. Each deny_paths
// entry also matches by its base name, so checking the final name covers links in parent
// directories too.
func openAllowedFile(root *os.Root, dir, path string, denyPaths []string) (*os.File, error) {
	missing := fmt.Errorf("file is missing, unreadable or outside the allowed directory")
	requested := path
	for hops := 0; ; hops++ {
		if offending, denied := builtin.DeniedPath(filepath.Join(dir, path), denyPaths); denied {
			return nil, fmt.Errorf("send_file denied for path %q (matched %q in tools.read_file.deny_paths)", requested, offending)
		}
		before, err := root.Lstat(path)
		if err != nil {
			return nil, missing
		}
		if before.Mode()&os.ModeSymlink != 0 {
			if hops >= maxSendFileSymlinks {
				return nil, fmt.Errorf("too many symlinks for path %q", requested)
			}
			target, err := root.Readlink(path)
			if err != nil {
				return nil, missing
			}
			next := filepath.Join(filepath.Dir(path), target)
			if filepath.IsAbs(target) {
				if next, err = filepath.Rel(dir, target); err != nil {
					return nil, missing
				}
			}
			if !filepath.IsLocal(next) {
				return nil, missing
			}
			path = next
			continue
		}
		if !before.Mode().IsRegular() {
			return nil, fmt.Errorf("file must be a regular file")
		}
		file, err := root.Open(path)
		if err != nil {
			return nil, missing
		}
		opened, err := file.Stat()
		if err != nil {
			_ = file.Close()
			return nil, missing
		}
		after, err := root.Lstat(path)
		if err != nil || !os.SameFile(opened, before) || !os.SameFile(opened, after) {
			_ = file.Close()
			return nil, errSendFileChanged
		}
		return file, nil
	}
}

func (s *server) handleReceivedAttachment(w http.ResponseWriter, r *http.Request) {
	if s.localRuntime == nil {
		writeError(w, http.StatusServiceUnavailable, "console is unavailable")
		return
	}
	s.localRuntime.store.ServeAttachment(w, r)
}

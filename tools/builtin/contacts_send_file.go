package builtin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/filecache"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

// contactsSendFileMaxBytes is the largest file contacts_send uploads. A channel with a smaller limit
// lowers it at delivery.
const contactsSendFileMaxBytes = int64(20 << 20)

// parseContactsSendFile validates the file parameters and the file they name. It returns nil when
// the call sends no file.
func parseContactsSendFile(ctx context.Context, params map[string]any, roots pathroots.PathRoots, policy contactSendExecutionPolicy) (*contacts.ShareFile, error) {
	rawPath, hasPath, err := contactsSendStringParam(params, "path")
	if err != nil {
		return nil, err
	}
	rawFilename, hasFilename, err := contactsSendStringParam(params, "filename")
	if err != nil {
		return nil, err
	}
	if !policy.allowFiles && (hasPath || hasFilename) {
		return nil, fmt.Errorf("%s sends text only; path and filename are not supported", policy.toolName)
	}
	if !hasPath {
		if hasFilename {
			return nil, fmt.Errorf("filename requires path")
		}
		return nil, nil
	}
	if strings.TrimSpace(rawPath) == "" {
		return nil, fmt.Errorf("path must not be empty")
	}
	if raw, ok := params["message_base64"]; ok && raw != nil {
		return nil, fmt.Errorf("path cannot be combined with message_base64; use message_text as the caption")
	}
	if raw, ok := params["message_text"]; ok && raw != nil {
		if _, isString := raw.(string); !isString {
			return nil, fmt.Errorf("message_text must be a string")
		}
	}

	path, err := resolveContactsSendFilePath(pathroots.Resolve(ctx, roots), rawPath)
	if err != nil {
		return nil, err
	}
	size, digest, err := hashContactsSendFile(path)
	if err != nil {
		return nil, err
	}
	filename := strings.TrimSpace(rawFilename)
	if filename == "" {
		filename = filepath.Base(path)
	}
	return &contacts.ShareFile{
		Path:     path,
		Filename: filecache.SanitizeFilename(filename),
		Size:     size,
		SHA256:   digest,
	}, nil
}

func contactsSendStringParam(params map[string]any, key string) (string, bool, error) {
	raw, ok := params[key]
	if !ok || raw == nil {
		return "", false, nil
	}
	value, isString := raw.(string)
	if !isString {
		return "", false, fmt.Errorf("%s must be a string", key)
	}
	return value, true, nil
}

// resolveContactsSendFilePath resolves rawPath to a regular file inside file_cache_dir or the
// workspace directory, following symlinks. An alias picks its root; a relative path is looked up in
// file_cache_dir, then in the workspace. file_state_dir is never allowed, even inside a workspace.
func resolveContactsSendFilePath(roots pathroots.PathRoots, rawPath string) (string, error) {
	rawPath = pathutil.ExpandHomePath(strings.TrimSpace(rawPath))
	var candidate string
	alias, rest := detectPathAlias(rawPath)
	switch {
	case alias == "file_state_dir":
		return "", fmt.Errorf("refusing to send a file from file_state_dir; copy it into file_cache_dir first")
	case alias != "":
		resolved, err := resolveAliasedPath(roots, alias, rest, true)
		if err != nil {
			return "", err
		}
		candidate = resolved
	case filepath.IsAbs(rawPath):
		candidate = filepath.Clean(rawPath)
	default:
		for _, root := range []string{roots.FileCacheDir, roots.WorkspaceDir} {
			if strings.TrimSpace(root) == "" {
				continue
			}
			rootAbs, err := filepath.Abs(root)
			if err != nil {
				return "", err
			}
			path := filepath.Join(rootAbs, rawPath)
			if candidate == "" {
				candidate = path
			}
			if _, err := os.Lstat(path); err == nil {
				candidate = path
				break
			}
		}
		if candidate == "" {
			return "", fmt.Errorf("file_cache_dir and workspace_dir are not configured")
		}
	}

	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("file not found: %s", candidate)
		}
		return "", err
	}
	if withinResolvedRoot(roots.FileStateDir, resolved) {
		return "", fmt.Errorf("refusing to send a file from file_state_dir; copy it into file_cache_dir first")
	}
	if !withinResolvedRoot(roots.FileCacheDir, resolved) && !withinResolvedRoot(roots.WorkspaceDir, resolved) {
		return "", fmt.Errorf("refusing to send a file outside file_cache_dir and workspace_dir: %s; copy it into file_cache_dir first", resolved)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory: %s", resolved)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("path is not a regular file: %s", resolved)
	}
	if info.Size() > contactsSendFileMaxBytes {
		return "", fmt.Errorf("file too large to send (>%d bytes): %s", contactsSendFileMaxBytes, resolved)
	}
	return resolved, nil
}

// withinResolvedRoot reports whether path lies inside root, both with symlinks resolved.
func withinResolvedRoot(root, path string) bool {
	root = strings.TrimSpace(root)
	if root == "" {
		return false
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	rootResolved, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return false
	}
	return pathutil.IsWithinDir(rootResolved, path)
}

func hashContactsSendFile(path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, io.LimitReader(f, contactsSendFileMaxBytes+1))
	if err != nil {
		return 0, "", err
	}
	if size > contactsSendFileMaxBytes {
		return 0, "", fmt.Errorf("file too large to send (>%d bytes): %s", contactsSendFileMaxBytes, path)
	}
	return size, hex.EncodeToString(h.Sum(nil)), nil
}

// auditContactsSendFile records a file delivery in the guard audit log. It returns the audit
// error, if any, for the tool result; the delivery itself already happened.
func auditContactsSendFile(ctx context.Context, toolName string, file *contacts.ShareFile, recipients []string, outcome contacts.ShareOutcome) error {
	status := "sent"
	switch {
	case outcome.Partial:
		status = "partial"
	case strings.TrimSpace(outcome.Error) != "":
		status = "failed"
	}
	return guard.AuditFileSend(ctx, toolName, guard.FileSend{
		Recipients: append([]string(nil), recipients...),
		Path:       file.Path,
		Filename:   file.Filename,
		Size:       file.Size,
		SHA256:     file.SHA256,
		Status:     status,
	})
}

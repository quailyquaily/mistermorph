package builtin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/agentlink"
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
		Path:        path,
		Filename:    filecache.SanitizeFilename(filename),
		DisplayName: agentlink.CleanAttachmentName(filename),
		Size:        size,
		SHA256:      digest,
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

// checkFileRecipient checks, before anything is sent, that a file can go to contact: over Agent
// Link, within its size limit and to an agent that takes files. agent_send sends files over Agent
// Link only.
func checkFileRecipient(policy contactSendExecutionPolicy, contactID string, contact contacts.Contact, chatID string, file *contacts.ShareFile) error {
	if file == nil {
		return nil
	}
	node, instanceID, ok := agentLinkInstanceFor(policy.stateDir, contact, chatID)
	if !ok {
		if policy.agentLinkFilesOnly {
			return fmt.Errorf("%s sends files only to Agent Link agents (mm: contacts) while Agent Link runs; %q is not one, use contacts_send for other channels", policy.toolName, strings.TrimSpace(contactID))
		}
		return nil
	}
	if file.Size > agentlink.MaxAttachmentBytes {
		return fmt.Errorf("file too large for Agent Link (%d bytes; at most %d): %s", file.Size, agentlink.MaxAttachmentBytes, file.Path)
	}
	if node.Reachable(instanceID) && !node.SupportsFiles(instanceID) {
		return fmt.Errorf("%s: %q cannot take files: %w (its runtime or the Console that reaches it is too old); send text only", policy.toolName, strings.TrimSpace(contactID), agentlink.ErrFilesUnsupported)
	}
	return nil
}

// attachToAgentLinkReply handles a file a task answering an Agent Link message sends to the agent
// that asked: the file goes with the task's answer, which is the reply. It reports whether the call
// was such a file.
func attachToAgentLinkReply(ctx context.Context, params map[string]any, contactIDs []string, file *contacts.ShareFile, policy contactSendExecutionPolicy) (string, bool, error) {
	replyFiles, ok := agentlink.ReplyFilesFromContext(ctx)
	if !ok || file == nil {
		return "", false, nil
	}
	toAsker := false
	for _, contactID := range contactIDs {
		if instanceID, ok := agentlink.InstanceIDFromContactID(contactID); ok && strings.EqualFold(instanceID, replyFiles.Peer()) {
			toAsker = true
		}
	}
	if !toAsker {
		return "", false, nil
	}
	if len(contactIDs) > 1 {
		return "", true, fmt.Errorf("a file for your answer to %s goes on its own %s call, with only that contact_id", agentlink.ContactID(replyFiles.Peer()), policy.toolName)
	}
	if file.Size > agentlink.MaxAttachmentBytes {
		return "", true, fmt.Errorf("file too large for Agent Link (%d bytes; at most %d): %s", file.Size, agentlink.MaxAttachmentBytes, file.Path)
	}
	if node, ok := agentlink.Lookup(policy.stateDir); ok && node.Reachable(replyFiles.Peer()) && !node.SupportsFiles(replyFiles.Peer()) {
		return "", true, fmt.Errorf("%s: %q cannot take files: %w (its runtime or the Console that reaches it is too old); answer in text only", policy.toolName, contactIDs[0], agentlink.ErrFilesUnsupported)
	}
	name := file.DisplayName
	if name == "" {
		name = file.Filename
	}
	attachment, err := agentlink.ReadAttachmentFile(file.Path, name, file.Size, file.SHA256)
	if err != nil {
		return "", true, err
	}
	if err := replyFiles.Add(attachment); err != nil {
		return "", true, err
	}
	result := map[string]any{
		"status":     "attached_to_reply",
		"contact_id": strings.TrimSpace(contactIDs[0]),
		"attachment": attachment.Meta(),
		"note":       "The file goes back with your final answer, which is the reply text. Do not send it again.",
	}
	if err := guard.AuditFileSend(ctx, policy.toolName, guard.FileSend{
		Recipients: []string{strings.TrimSpace(contactIDs[0])},
		Path:       file.Path,
		Filename:   attachment.Filename,
		Size:       attachment.Size,
		SHA256:     attachment.SHA256,
		Status:     "attached",
	}); err != nil {
		result["audit_error"] = err.Error()
	}
	if text, _ := params["message_text"].(string); strings.TrimSpace(text) != "" {
		result["note"] = "The file goes back with your final answer, which is the reply text; message_text is not sent, so say it in your final answer. Do not send the file again."
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return string(out), true, nil
}

package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/topicstate"
)

type Attachment struct {
	WorkspaceDir string `json:"workspace_dir"`
}

type Source string

const (
	SourceNone       Source = "none"
	SourceDefault    Source = "default"
	SourceAttachment Source = "attachment"
)

type Resolution struct {
	WorkspaceDir string
	Source       Source
}

// Store keeps each conversation's attached workspace in its topic folder,
// file_state_dir/topics/<key>/workspace.json. path names the old shared file,
// workspace_attachments.json in the state dir; whatever it still holds is moved into the topic
// folders the first time the store is used.
type Store struct {
	path      string
	stateDir  string
	mu        sync.Mutex
	migrateMu sync.Mutex
	migrated  bool
}

type attachmentFile struct {
	Version     int                   `json:"version"`
	Attachments map[string]Attachment `json:"attachments"`
}

const attachmentFileName = "workspace.json"

func NewStore(path string) *Store {
	path = strings.TrimSpace(path)
	stateDir := ""
	if path != "" {
		stateDir = filepath.Dir(path)
	}
	return &Store{path: path, stateDir: stateDir}
}

func (s *Store) Get(scopeKey string) (Attachment, bool, error) {
	scopeKey = strings.TrimSpace(scopeKey)
	if s == nil || s.stateDir == "" || scopeKey == "" {
		return Attachment{}, false, nil
	}
	if err := s.migrateLegacy(); err != nil {
		return Attachment{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked(scopeKey)
}

func (s *Store) Set(scopeKey string, attachment Attachment) (Attachment, bool, error) {
	scopeKey = strings.TrimSpace(scopeKey)
	attachment.WorkspaceDir = strings.TrimSpace(attachment.WorkspaceDir)
	if s == nil || s.stateDir == "" || scopeKey == "" {
		return Attachment{}, false, nil
	}
	if attachment.WorkspaceDir == "" {
		return Attachment{}, false, fmt.Errorf("workspace dir is required")
	}
	var prev Attachment
	var hadPrev bool
	err := s.withMutationLock(scopeKey, func() error {
		var err error
		prev, hadPrev, err = s.readLocked(scopeKey)
		if err != nil {
			return err
		}
		return fsstore.WriteJSONAtomic(s.attachmentPath(scopeKey), attachment, fsstore.FileOptions{})
	})
	if err != nil {
		return Attachment{}, false, err
	}
	return prev, hadPrev, nil
}

func (s *Store) Delete(scopeKey string) (Attachment, bool, error) {
	scopeKey = strings.TrimSpace(scopeKey)
	if s == nil || s.stateDir == "" || scopeKey == "" {
		return Attachment{}, false, nil
	}
	var prev Attachment
	var hadPrev bool
	err := s.withMutationLock(scopeKey, func() error {
		var err error
		prev, hadPrev, err = s.readLocked(scopeKey)
		if err != nil || !hadPrev {
			return err
		}
		if err := os.Remove(s.attachmentPath(scopeKey)); err != nil && !os.IsNotExist(err) {
			return err
		}
		topicstate.RemoveIfEmpty(s.stateDir, scopeKey)
		return nil
	})
	if err != nil {
		return Attachment{}, false, err
	}
	return prev, hadPrev, nil
}

func (s *Store) withMutationLock(scopeKey string, fn func() error) error {
	if err := s.migrateLegacy(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return fsstore.WithLock(context.Background(), topicstate.LockPath(s.stateDir, scopeKey), fn)
}

func (s *Store) attachmentPath(scopeKey string) string {
	return filepath.Join(topicstate.Dir(s.stateDir, scopeKey), attachmentFileName)
}

func (s *Store) readLocked(scopeKey string) (Attachment, bool, error) {
	var att Attachment
	found, err := fsstore.ReadJSON(s.attachmentPath(scopeKey), &att)
	if err != nil || !found {
		return Attachment{}, false, err
	}
	att.WorkspaceDir = strings.TrimSpace(att.WorkspaceDir)
	if att.WorkspaceDir == "" {
		return Attachment{}, false, nil
	}
	return att, true, nil
}

// migrateLegacy moves the attachments of the old shared file into their topic folders, keeping
// any attachment already there, and then removes the old file.
func (s *Store) migrateLegacy() error {
	s.migrateMu.Lock()
	defer s.migrateMu.Unlock()
	if s.migrated || s.path == "" {
		return nil
	}
	if _, err := os.Stat(s.path); os.IsNotExist(err) {
		s.migrated = true
		return nil
	}
	lockPath := s.path + ".lck"
	err := fsstore.WithLock(context.Background(), lockPath, func() error {
		var persisted attachmentFile
		found, err := fsstore.ReadJSON(s.path, &persisted)
		if err != nil || !found {
			return err
		}
		for scopeKey, att := range persisted.Attachments {
			scopeKey = strings.TrimSpace(scopeKey)
			att.WorkspaceDir = strings.TrimSpace(att.WorkspaceDir)
			if scopeKey == "" || att.WorkspaceDir == "" {
				continue
			}
			err := fsstore.WithLock(context.Background(), topicstate.LockPath(s.stateDir, scopeKey), func() error {
				if _, err := os.Stat(s.attachmentPath(scopeKey)); err == nil {
					return nil
				}
				return fsstore.WriteJSONAtomic(s.attachmentPath(scopeKey), att, fsstore.FileOptions{})
			})
			if err != nil {
				return err
			}
		}
		if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("move workspace attachments into topic folders: %w", err)
	}
	_ = os.Remove(lockPath)
	s.migrated = true
	return nil
}

type CommandAction string

const (
	CommandStatus CommandAction = "status"
	CommandAttach CommandAction = "attach"
	CommandDetach CommandAction = "detach"
)

type Command struct {
	Action CommandAction
	Dir    string
}

type CommandResult struct {
	Reply        string
	WorkspaceDir string
}

func ParseCommandArgs(args string) (Command, error) {
	args = strings.TrimSpace(args)
	if args == "" {
		return Command{Action: CommandStatus}, nil
	}
	parts := strings.Fields(args)
	switch strings.ToLower(parts[0]) {
	case "attach":
		dir := strings.TrimSpace(args[len(parts[0]):])
		if dir == "" {
			return Command{}, fmt.Errorf("usage: /workspace | /workspace attach <dir> | /workspace detach")
		}
		return Command{Action: CommandAttach, Dir: dir}, nil
	case "detach":
		if len(parts) != 1 {
			return Command{}, fmt.Errorf("usage: /workspace | /workspace attach <dir> | /workspace detach")
		}
		return Command{Action: CommandDetach}, nil
	default:
		return Command{}, fmt.Errorf("usage: /workspace | /workspace attach <dir> | /workspace detach")
	}
}

func LookupWorkspaceDir(store *Store, scopeKey string) (string, error) {
	if store == nil {
		return "", nil
	}
	att, ok, err := store.Get(scopeKey)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", nil
	}
	return strings.TrimSpace(att.WorkspaceDir), nil
}

func Resolve(store *Store, scopeKey string, defaultDir string) (Resolution, error) {
	attachedDir, err := LookupWorkspaceDir(store, scopeKey)
	if err != nil {
		return Resolution{}, err
	}
	if attachedDir != "" {
		return Resolution{WorkspaceDir: attachedDir, Source: SourceAttachment}, nil
	}
	defaultDir = strings.TrimSpace(defaultDir)
	if defaultDir != "" {
		return Resolution{WorkspaceDir: defaultDir, Source: SourceDefault}, nil
	}
	return Resolution{Source: SourceNone}, nil
}

func ExecuteStoreCommand(store *Store, scopeKey string, args string, defaultDir string, allowRoots []string) (CommandResult, error) {
	if store == nil {
		return CommandResult{}, fmt.Errorf("workspace store is not configured")
	}
	cmd, err := ParseCommandArgs(args)
	if err != nil {
		return CommandResult{}, err
	}
	current, err := Resolve(store, scopeKey, defaultDir)
	if err != nil {
		return CommandResult{}, err
	}
	switch cmd.Action {
	case CommandStatus:
		return CommandResult{
			Reply:        ResolutionStatusText(current),
			WorkspaceDir: current.WorkspaceDir,
		}, nil
	case CommandAttach:
		dir, err := ValidateDir(cmd.Dir, allowRoots)
		if err != nil {
			return CommandResult{}, err
		}
		prev, hadPrev, err := store.Set(scopeKey, Attachment{WorkspaceDir: dir})
		if err != nil {
			return CommandResult{}, err
		}
		return CommandResult{
			Reply:        AttachText(prev.WorkspaceDir, dir, hadPrev),
			WorkspaceDir: dir,
		}, nil
	case CommandDetach:
		prev, hadPrev, err := store.Delete(scopeKey)
		if err != nil {
			return CommandResult{}, err
		}
		resolved, err := Resolve(store, scopeKey, defaultDir)
		if err != nil {
			return CommandResult{}, err
		}
		reply := ""
		if hadPrev {
			reply = DetachText(prev.WorkspaceDir, true) + "\n" + ResolutionStatusText(resolved)
		} else if resolved.Source == SourceDefault {
			reply = ResolutionStatusText(resolved) + "; no attachment to detach"
		} else {
			reply = DetachText("", false)
		}
		return CommandResult{
			Reply:        reply,
			WorkspaceDir: resolved.WorkspaceDir,
		}, nil
	default:
		return CommandResult{}, fmt.Errorf("unsupported workspace command")
	}
}

func ResolveInitialWorkspace(cwd string, raw string, disabled bool, defaultDir string, allowRoots []string) (string, error) {
	if disabled {
		return "", nil
	}
	target := strings.TrimSpace(raw)
	if target == "" {
		target = strings.TrimSpace(defaultDir)
	}
	if target == "" {
		target = strings.TrimSpace(cwd)
	}
	if target == "" {
		return "", nil
	}
	return ValidateDir(target, allowRoots)
}

func ValidateDefaultDir(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	return ValidateDir(raw, nil)
}

func ValidateDir(raw string, allowRoots []string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("workspace dir is required")
	}
	resolved, err := filepath.Abs(pathutil.ExpandHomePath(raw))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("workspace dir does not exist: %s", resolved)
		}
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("workspace dir is not a directory: %s", resolved)
	}
	if _, err := os.ReadDir(resolved); err != nil {
		return "", fmt.Errorf("workspace dir is not readable: %s", resolved)
	}
	allowed := normalizedAllowRoots(allowRoots)
	if len(allowed) > 0 {
		for _, root := range allowed {
			if pathutil.IsWithinDir(root, resolved) || filepath.Clean(root) == filepath.Clean(resolved) {
				return resolved, nil
			}
		}
		return "", fmt.Errorf("workspace dir is outside allowed roots: %s", resolved)
	}
	return resolved, nil
}

func StatusText(current string) string {
	current = strings.TrimSpace(current)
	if current == "" {
		return "workspace: (none)"
	}
	return "workspace: " + current
}

func ResolutionStatusText(resolution Resolution) string {
	current := strings.TrimSpace(resolution.WorkspaceDir)
	if current == "" || resolution.Source == SourceNone {
		return "workspace: (none)"
	}
	return fmt.Sprintf("workspace: %s (%s)", current, resolution.Source)
}

func AttachText(oldDir string, newDir string, replaced bool) string {
	oldDir = strings.TrimSpace(oldDir)
	newDir = strings.TrimSpace(newDir)
	if replaced && oldDir != "" && oldDir != newDir {
		return fmt.Sprintf("workspace replaced: %s -> %s", oldDir, newDir)
	}
	if oldDir == newDir && newDir != "" {
		return "workspace unchanged: " + newDir
	}
	return "workspace attached: " + newDir
}

func DetachText(oldDir string, detached bool) string {
	oldDir = strings.TrimSpace(oldDir)
	if !detached || oldDir == "" {
		return "workspace: already detached"
	}
	return "workspace detached: " + oldDir
}

func normalizedAllowRoots(roots []string) []string {
	out := make([]string, 0, len(roots))
	seen := map[string]bool{}
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		absRoot, err := filepath.Abs(pathutil.ExpandHomePath(root))
		if err != nil {
			continue
		}
		absRoot = filepath.Clean(absRoot)
		if seen[absRoot] {
			continue
		}
		seen[absRoot] = true
		out = append(out, absRoot)
	}
	return out
}

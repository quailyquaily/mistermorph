package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
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

// Store keeps each conversation's attached workspace in agent.db (workspace_attachments), keyed by
// the scope key. path names the old shared file, workspace_attachments.json in the state folder;
// agent.db is beside it.
type Store struct {
	path     string
	stateDir string
	db       *agentdb.Lazy
}

func NewStore(path string) *Store {
	path = strings.TrimSpace(path)
	stateDir := ""
	if path != "" {
		stateDir = filepath.Dir(path)
	}
	store := &Store{path: path, stateDir: stateDir}
	if stateDir != "" {
		store.db = agentdb.NewLazy(filepath.Join(stateDir, statepaths.AgentDBFilename))
	}
	return store
}

func (s *Store) Get(scopeKey string) (Attachment, bool, error) {
	scopeKey = strings.TrimSpace(scopeKey)
	if s == nil || s.stateDir == "" || scopeKey == "" {
		return Attachment{}, false, nil
	}
	db, err := s.db.Get(context.Background())
	if err != nil {
		return Attachment{}, false, err
	}
	return readAttachment(context.Background(), db, db, scopeKey)
}

type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// readAttachment reads the scope's row. A workspace.json the import could not key is imported the
// first time its scope is asked for.
func readAttachment(ctx context.Context, q queryer, db *agentdb.DB, scopeKey string) (Attachment, bool, error) {
	var att Attachment
	err := q.QueryRowContext(ctx, `SELECT workspace_dir FROM workspace_attachments WHERE scope_key = ?`, scopeKey).Scan(&att.WorkspaceDir)
	if errors.Is(err, sql.ErrNoRows) {
		if db == nil {
			return Attachment{}, false, nil
		}
		dir, err := topicstate.ImportFolderWorkspace(ctx, db, scopeKey)
		if err != nil || dir == "" {
			return Attachment{}, false, err
		}
		return Attachment{WorkspaceDir: dir}, true, nil
	}
	if err != nil {
		return Attachment{}, false, err
	}
	att.WorkspaceDir = strings.TrimSpace(att.WorkspaceDir)
	if att.WorkspaceDir == "" {
		return Attachment{}, false, nil
	}
	return att, true, nil
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
	err := s.withTx(scopeKey, func(ctx context.Context, tx *sql.Tx) error {
		var err error
		prev, hadPrev, err = readAttachment(ctx, tx, nil, scopeKey)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO workspace_attachments (scope_key, workspace_dir, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (scope_key) DO UPDATE SET workspace_dir = excluded.workspace_dir, updated_at = excluded.updated_at`,
			scopeKey, attachment.WorkspaceDir, agentdb.Now())
		return err
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
	err := s.withTx(scopeKey, func(ctx context.Context, tx *sql.Tx) error {
		var err error
		prev, hadPrev, err = readAttachment(ctx, tx, nil, scopeKey)
		if err != nil || !hadPrev {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM workspace_attachments WHERE scope_key = ?`, scopeKey)
		return err
	})
	if err != nil {
		return Attachment{}, false, err
	}
	return prev, hadPrev, nil
}

// withTx runs fn in one transaction, after importing the scope's workspace.json if the import
// left it in its folder.
func (s *Store) withTx(scopeKey string, fn func(context.Context, *sql.Tx) error) error {
	ctx := context.Background()
	db, err := s.db.Get(ctx)
	if err != nil {
		return err
	}
	if _, err := topicstate.ImportFolderWorkspace(ctx, db, scopeKey); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
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

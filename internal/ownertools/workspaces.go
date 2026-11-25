package ownertools

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

const (
	workspaceListDefault = 20
	workspaceListMax     = 50
	// workspaceTopicsMax is how many topic titles one workspace lists.
	workspaceTopicsMax = 10
)

// knownWorkspace is one workspace the agent knows, gathered from the attachments, the default and
// the recent uses.
type knownWorkspace struct {
	Path        string     `json:"path"`
	Display     string     `json:"display"`
	Exists      bool       `json:"exists"`
	LastUsed    string     `json:"last_used,omitempty"`
	Kinds       []string   `json:"kinds"`
	Topics      []topicRef `json:"topics,omitempty"`
	TopicsMore  int        `json:"topics_more,omitempty"`
	Current     bool       `json:"current,omitempty"`
	TopicOwn    bool       `json:"topic_workspace,omitempty"`
	lastUsed    time.Time
	topicsTotal int
}

type topicRef struct {
	ID    string `json:"id"`
	Title string `json:"title,omitempty"`
}

func (w *knownWorkspace) addKind(kind string) {
	for _, k := range w.Kinds {
		if k == kind {
			return
		}
	}
	w.Kinds = append(w.Kinds, kind)
}

func (w *knownWorkspace) used(at time.Time) {
	if at.After(w.lastUsed) {
		w.lastUsed = at
	}
}

// knownWorkspaces gathers the workspaces the agent knows, keyed by their cleaned path: those
// attached to live Console topics (with the topics), the default, the recently used, and the run's
// own and current ones.
func (d *Deps) knownWorkspaces() ([]*knownWorkspace, error) {
	byKey := map[string]*knownWorkspace{}
	var order []*knownWorkspace
	get := func(dir string) *knownWorkspace {
		dir = cleanDir(dir)
		if dir == "" {
			return nil
		}
		if w, ok := byKey[dir]; ok {
			return w
		}
		w := &knownWorkspace{Path: dir, Display: displayPath(dir, d.HomeDir)}
		byKey[dir] = w
		order = append(order, w)
		return w
	}
	if d.Workspaces != nil {
		attached, err := d.Workspaces.ListAttachments(ConsoleScopePrefix)
		if err != nil {
			return nil, err
		}
		for _, rec := range attached {
			topicID := strings.TrimPrefix(rec.ScopeKey, ConsoleScopePrefix)
			var ref topicRef
			if d.Topics != nil {
				topic, ok := d.Topics.GetTopic(topicID)
				if !ok || topic == nil || topic.DeletedAt != nil {
					// A deleted topic's attachment is not a workspace the agent knows from it.
					continue
				}
				ref = topicRef{ID: topic.ID, Title: strings.TrimSpace(topic.Title)}
			} else {
				ref = topicRef{ID: topicID}
			}
			w := get(rec.WorkspaceDir)
			if w == nil {
				continue
			}
			w.addKind("attached")
			w.used(rec.UpdatedAt)
			w.topicsTotal++
			if len(w.Topics) < workspaceTopicsMax {
				w.Topics = append(w.Topics, ref)
			}
		}
		uses, err := d.Workspaces.RecentUses(workspace.MaxRecentUses)
		if err != nil {
			return nil, err
		}
		for _, use := range uses {
			if w := get(use.WorkspaceDir); w != nil {
				w.addKind("recent")
				w.used(use.UsedAt)
			}
		}
	}
	if w := get(d.DefaultWorkspaceDir); w != nil {
		w.addKind("default")
	}
	if d.Switch != nil {
		if w := get(d.Switch.Original()); w != nil {
			w.TopicOwn = true
		}
		if w := get(d.Switch.Current()); w != nil {
			w.Current = true
		}
	}
	for _, w := range order {
		if w.Kinds == nil {
			w.Kinds = []string{}
		}
		w.TopicsMore = w.topicsTotal - len(w.Topics)
		w.LastUsed = formatTime(w.lastUsed)
		info, err := os.Stat(w.Path)
		w.Exists = err == nil && info.IsDir()
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := order[i], order[j]
		if !a.lastUsed.Equal(b.lastUsed) {
			return a.lastUsed.After(b.lastUsed)
		}
		return a.Path < b.Path
	})
	return order, nil
}

type workspaceListTool struct {
	ownerTool
	deps *Deps
}

func (t *workspaceListTool) Name() string       { return WorkspaceListName }
func (t *workspaceListTool) ParallelSafe() bool { return true }

func (t *workspaceListTool) Description() string {
	return "Lists the local workspaces (project folders) you know: those attached to the owner's Console topics, with the topics' titles, the default workspace and the recently used ones, most recently used first. " +
		"Each has its path, whether it still exists and when it was last used; current marks the one this task uses now, topic_workspace the topic's own. " +
		"Use it when the user refers to another project or folder, before workspace_use. Read-only."
}

func (t *workspaceListTool) ParameterSchema() string {
	return schema(map[string]any{
		"limit": prop("integer", fmt.Sprintf("At most this many, 1-%d. Default %d.", workspaceListMax, workspaceListDefault)),
	})
}

func (t *workspaceListTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if err := checkCall(ctx, t.Name(), t.deps); err != nil {
		return "", err
	}
	if err := rejectUnknown(params, "limit"); err != nil {
		return "", err
	}
	limit := limitParam(params, workspaceListDefault, workspaceListMax)
	all, err := t.deps.knownWorkspaces()
	if err != nil {
		return "", err
	}
	more := len(all) > limit
	if more {
		all = all[:limit]
	}
	return result(map[string]any{"workspaces": all, "has_more": more})
}

type workspaceUseTool struct {
	ownerTool
	deps *Deps
}

func (t *workspaceUseTool) Name() string { return WorkspaceUseName }

// CodeModeExcluded: a switch changes where every later call works, so the model makes it directly.
func (t *workspaceUseTool) CodeModeExcluded() bool { return true }

func (t *workspaceUseTool) Description() string {
	return "Switches this task to another workspace for the rest of the task: read_file, write_file, bash/powershell's working directory, send_file and workspace_dir/ paths then work there. " +
		"The path must be a workspace from workspace_list (or a folder inside one), or a folder the user named in this message. The topic's own attached workspace does not change; pass the topic's workspace to switch back. " +
		"Reading needs no approval; the first write or command in a workspace other than the topic's asks the user to approve, once per workspace in this task."
}

func (t *workspaceUseTool) ParameterSchema() string {
	return schema(map[string]any{
		"path": prop("string", "The workspace folder: an absolute path, or one starting with ~/. A relative path is taken from the workspace in use."),
	}, "path")
}

func (t *workspaceUseTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if err := checkCall(ctx, t.Name(), t.deps); err != nil {
		return "", err
	}
	if err := rejectUnknown(params, "path"); err != nil {
		return "", err
	}
	d := t.deps
	if d.Switch == nil {
		return "", errNotOwnerRun(t.Name())
	}
	raw := stringParam(params, "path")
	if raw == "" {
		return "", fmt.Errorf("path is required")
	}
	target := pathutil.ExpandHomePath(raw)
	if !filepath.IsAbs(target) {
		base := strings.TrimSpace(d.Switch.Current())
		if base == "" {
			return "", fmt.Errorf("path %q is relative and this task has no workspace to take it from; give an absolute path", raw)
		}
		target = filepath.Join(base, target)
	}
	dir, err := workspace.ValidateDir(target, nil)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", fmt.Errorf("workspace dir is not readable: %s", dir)
	}
	if err := d.checkAllowedDir(dir, real); err != nil {
		return "", err
	}
	known, err := d.knownWorkspaces()
	if err != nil {
		return "", err
	}
	if !isKnownDir(known, dir, real) && !mentionsAnyPath(d.UserText, raw, dir, displayPath(dir, d.HomeDir)) {
		return "", fmt.Errorf("%s is not a workspace you know (see workspace_list) nor a folder the user named in this message; ask the user before working there", displayPath(dir, d.HomeDir))
	}
	d.Switch.Use(dir)
	if d.Workspaces != nil {
		if err := d.Workspaces.RecordUse(dir, d.now()); err != nil {
			slog.Default().Warn("workspace_use_record_failed", "error", err.Error())
		}
	}
	display := displayPath(dir, d.HomeDir)
	own := sameRealDir(dir, d.Switch.Original())
	_, pending := d.Switch.PendingApproval()
	out := map[string]any{
		"workspace_dir":   dir,
		"display":         display,
		"activity":        "Using " + display,
		"topic_workspace": displayPath(d.Switch.Original(), d.HomeDir),
		"is_topic_own":    own,
	}
	switch {
	case own:
		out["note"] = "Back in the topic's own workspace."
	case pending:
		out["note"] = "Reads work now. The first write or command here asks the user to approve, once for this task; the topic's attached workspace is unchanged."
	default:
		out["note"] = "Writes and commands here were already approved in this task; the topic's attached workspace is unchanged."
	}
	return result(out)
}

// checkAllowedDir refuses a workspace that tools.read_file.deny_paths or the protected state files
// deny, by its path or by where its symlinks lead, and the agent's state folder or a folder in it.
func (d *Deps) checkAllowedDir(dir, real string) error {
	for _, p := range []string{dir, real} {
		if offending, denied := builtin.DeniedPath(p, d.DenyPaths); denied {
			return fmt.Errorf("workspace %s is denied (matched %q; see tools.read_file.deny_paths)", dir, offending)
		}
	}
	if state := strings.TrimSpace(d.StateDir); state != "" {
		stateAbs, err := filepath.Abs(pathutil.ExpandHomePath(state))
		if err == nil {
			stateReal, err := filepath.EvalSymlinks(stateAbs)
			if err != nil {
				stateReal = stateAbs
			}
			for _, p := range []string{dir, real} {
				for _, s := range []string{stateAbs, stateReal} {
					if withinOrSame(s, p) {
						return fmt.Errorf("the agent's state folder cannot be a workspace: %s", dir)
					}
				}
			}
		}
	}
	return nil
}

// isKnownDir reports whether dir (or where its symlinks lead) is a known workspace or a folder in
// one.
func isKnownDir(known []*knownWorkspace, dir, real string) bool {
	for _, w := range known {
		root := w.Path
		rootReal, err := filepath.EvalSymlinks(root)
		if err != nil {
			rootReal = root
		}
		for _, p := range []string{dir, real} {
			for _, r := range []string{root, rootReal} {
				if withinOrSame(r, p) {
					return true
				}
			}
		}
	}
	return false
}

func withinOrSame(root, p string) bool {
	root, p = filepath.Clean(root), filepath.Clean(p)
	return root == p || pathutil.IsWithinDir(root, p)
}

func sameRealDir(a, b string) bool {
	a, b = cleanDir(a), cleanDir(b)
	if a == "" || b == "" {
		return a == b
	}
	if a == b {
		return true
	}
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && filepath.Clean(ra) == filepath.Clean(rb)
}

func cleanDir(dir string) string {
	dir = strings.TrimSpace(pathutil.ExpandHomePath(strings.TrimSpace(dir)))
	if dir == "" {
		return ""
	}
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	return filepath.Clean(dir)
}

// displayPath shows a path under home with ~, as the Console does.
func displayPath(dir, home string) string {
	dir = cleanDir(dir)
	home = strings.TrimSpace(home)
	if dir == "" || home == "" {
		return dir
	}
	home = filepath.Clean(home)
	if dir == home {
		return "~"
	}
	if pathutil.IsWithinDir(home, dir) {
		rel, err := filepath.Rel(home, dir)
		if err == nil {
			return "~/" + filepath.ToSlash(rel)
		}
	}
	return dir
}

// mentionsAnyPath reports whether text names one of the paths as a whole path: the user wrote it
// in this message. Only absolute and ~ paths count; a bare name could match any word.
func mentionsAnyPath(text string, paths ...string) bool {
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" || !(filepath.IsAbs(p) || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`)) {
			continue
		}
		if mentionsPath(text, p) {
			return true
		}
	}
	return false
}

// mentionsPath finds path in text where it is not part of a longer path: what follows it is the
// end, a space or punctuation, not more of a name.
func mentionsPath(text, path string) bool {
	path = strings.TrimRight(path, `/\`)
	if len(path) < 2 {
		return false
	}
	for start := 0; start < len(text); {
		i := strings.Index(text[start:], path)
		if i < 0 {
			return false
		}
		begin := start + i
		end := begin + len(path)
		if end < len(text) && (text[end] == '/' || text[end] == '\\') {
			end++
		}
		if (begin == 0 || !isPathByte(text[begin-1])) && pathEndsAt(text, end) {
			return true
		}
		start = begin + 1
	}
	return false
}

// pathEndsAt reports whether a path ending at end in text is whole: what follows is the end of the
// text, or anything but more of a name once sentence punctuation is skipped.
func pathEndsAt(text string, end int) bool {
	for i := end; i < len(text); i++ {
		c := text[i]
		if strings.IndexByte(".,;:!?", c) >= 0 {
			continue
		}
		return !isPathByte(c)
	}
	return true
}

// isPathByte reports whether c can be part of a path's name.
func isPathByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	case c >= 0x80:
		return true
	}
	return strings.IndexByte("._-/\\~+@", c) >= 0
}

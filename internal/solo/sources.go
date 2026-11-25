package solo

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/memorytools"
	"github.com/quailyquaily/mistermorph/internal/ownertools"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

// SourceCollector gathers, from a Solo run's finished tool calls, the workspace it used and
// the threads and sources it touched: only what its calls actually did, never a guess.
type SourceCollector struct {
	mu      sync.Mutex
	runID   string
	home    string
	items   []daemonruntime.SoloSource
	seen    map[string]bool
	threads map[string]bool
}

func NewSourceCollector(runID string) *SourceCollector {
	return &SourceCollector{runID: strings.TrimSpace(runID), home: workspace.HostHomeDir(), seen: map[string]bool{}, threads: map[string]bool{}}
}

// workspaceTools are the calls that work in the run's workspace.
var workspaceTools = map[string]bool{
	"read_file": true, "write_file": true, "bash": true, "powershell": true, "coder": true,
}

// pathTools name the file they touch in a path argument; they count as workspace use only when
// that path resolves inside the workspace.
var pathTools = map[string]bool{"read_file": true, "write_file": true}

// PathInWorkspace reports whether the file a read_file/write_file call named is inside
// workspace dir. The path is resolved by the tools' own resolvers with the workspace as the only
// root, so what they would refuse there (file_cache_dir/ and file_state_dir/ aliases, paths that
// leave the workspace) never counts. Then the file's real place counts: a symlink in the workspace
// that points outside it is not the workspace, and a path through a link to the workspace is.
func PathInWorkspace(tool string, rawPath string, dir string) bool {
	if strings.TrimSpace(rawPath) == "" {
		return false
	}
	base, err := filepath.Abs(pathutil.ExpandHomePath(strings.TrimSpace(dir)))
	if err != nil {
		return false
	}
	roots := pathroots.New(base, "", "")
	var path string
	if tool == "write_file" {
		_, path, err = builtin.ResolveWritePath(roots, rawPath)
	} else {
		path, err = builtin.ResolveReadPath(roots, rawPath)
	}
	if err != nil {
		return false
	}
	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		realBase = base
	}
	realPath, err := evalSymlinksOfExisting(path)
	if err != nil {
		return false
	}
	return pathutil.IsWithinDir(realBase, realPath)
}

// evalSymlinksOfExisting resolves the symlinks of path's longest existing prefix (a file
// write_file creates need not exist yet) and joins the rest back on. A dangling link is followed
// to where it points, as a write through it would create its target there.
func evalSymlinksOfExisting(path string) (string, error) {
	for hops := 0; hops < 40; hops++ {
		rest := ""
		for {
			real, err := filepath.EvalSymlinks(path)
			if err == nil {
				return filepath.Join(real, rest), nil
			}
			if info, lerr := os.Lstat(path); lerr == nil && info.Mode()&os.ModeSymlink != 0 {
				target, rerr := os.Readlink(path)
				if rerr != nil {
					return "", rerr
				}
				if !filepath.IsAbs(target) {
					target = filepath.Join(filepath.Dir(path), target)
				}
				path = filepath.Join(target, rest)
				break
			}
			parent := filepath.Dir(path)
			if parent == path {
				return "", err
			}
			rest = filepath.Join(filepath.Base(path), rest)
			path = parent
		}
	}
	return "", fmt.Errorf("too many links: %s", path)
}

func (c *SourceCollector) HandleEvent(ctx context.Context, event agent.Event) {
	if c == nil || event.Kind != agent.EventKindToolDone || strings.TrimSpace(event.Error) != "" || event.Worker != nil {
		return
	}
	if runID := strings.TrimSpace(event.RunID); runID != "" && runID != c.runID {
		return
	}
	name := strings.TrimSpace(event.ToolName)
	switch {
	case name == ownertools.WorkspaceUseName:
		var out struct {
			Dir     string `json:"workspace_dir"`
			Display string `json:"display"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(event.Text)), &out) == nil && strings.TrimSpace(out.Dir) != "" {
			c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceWorkspace, ID: out.Dir, Label: out.Display})
		}
	case workspaceTools[name]:
		dir, ok := pathroots.WorkspaceDirFromContext(ctx)
		if !ok || strings.TrimSpace(dir) == "" {
			return
		}
		if pathTools[name] {
			path, _ := event.Args["path"].(string)
			if !PathInWorkspace(name, path, dir) {
				return
			}
		}
		c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceWorkspace, ID: dir, Label: ownertools.DisplayPath(dir, c.home)})
	case name == ownertools.TopicReadName:
		var out struct {
			Topic struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"topic"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(event.Text)), &out) == nil && strings.TrimSpace(out.Topic.ID) != "" {
			c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceTopic, ID: out.Topic.ID, Label: out.Topic.Title})
		}
	case name == ownertools.WorkThreadName:
		var out struct {
			TopicID   string `json:"topic_id"`
			Title     string `json:"title"`
			Workspace string `json:"workspace"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(event.Text)), &out) == nil && strings.TrimSpace(out.TopicID) != "" {
			c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceThread, ID: out.TopicID, Label: out.Title})
		}
	case name == memorytools.SearchName || name == memorytools.SaveName || name == memorytools.ForgetName:
		c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceMemory})
	case name == memorytools.JournalSearchName || name == memorytools.JournalReadName:
		c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceJournal})
	}
}

func (c *SourceCollector) add(source daemonruntime.SoloSource) {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := source.Kind + "\x00" + source.ID
	if c.seen[key] {
		return
	}
	c.seen[key] = true
	if source.Kind == daemonruntime.SoloSourceThread {
		c.threads[source.ID] = true
	}
	c.items = append(c.items, source)
}

// Sources is what the run used, in the order it first used each; a topic the run started a thread
// in shows once, as the thread.
func (c *SourceCollector) Sources() []daemonruntime.SoloSource {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]daemonruntime.SoloSource, 0, len(c.items))
	for _, item := range c.items {
		if item.Kind == daemonruntime.SoloSourceTopic && c.threads[item.ID] {
			continue
		}
		out = append(out, item)
	}
	return out
}

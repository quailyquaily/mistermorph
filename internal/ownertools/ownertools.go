// Package ownertools gives the Console owner's chat runs the tools that reach past the run's own
// topic: workspace_list and workspace_use (the workspaces the agent knows, and switching the run to
// another one), topic_search and topic_read (the owner's other Console topics). The owner may see
// every Console topic and use every workspace, so only the owner's own chat runs get them: channel
// runtimes, cron runs and subagents do not. Each tool is built for one run and checks, when it is
// called, that the call comes from that run, as the owner, and not from a subtask.
package ownertools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools"
)

const (
	WorkspaceListName = "workspace_list"
	WorkspaceUseName  = "workspace_use"
	TopicSearchName   = "topic_search"
	TopicReadName     = "topic_read"

	// ConsoleScopePrefix starts the scope key of a Console topic's workspace attachment.
	ConsoleScopePrefix = "console:"
)

// Names are the tools' names, in the order New returns them.
var Names = []string{WorkspaceListName, WorkspaceUseName, TopicSearchName, TopicReadName}

// Topics is the Console's topic and task store (daemonruntime.ConsoleFileStore).
type Topics interface {
	ListTopicsPage(opts daemonruntime.TopicListOptions) []daemonruntime.TopicInfo
	GetTopic(id string) (*daemonruntime.TopicInfo, bool)
	List(opts daemonruntime.TaskListOptions) []daemonruntime.TaskInfo
}

// Deps is what the tools of one run use.
type Deps struct {
	// RunID is the run the tools are built for; a call from any other run (a subtask) is refused.
	RunID string
	// Topics is the Console's topic and task store.
	Topics Topics
	// Workspaces holds the topics' workspace attachments and the recent workspace uses.
	Workspaces *workspace.Store
	// TopicWorkspace resolves a topic's workspace the way its runs do: the attachment, a TODO
	// item's own, or the default. Nil leaves topics without a workspace in the results.
	TopicWorkspace func(ctx context.Context, topicID string) (dir string, source string, err error)
	// DefaultWorkspaceDir is the configured default workspace (workspace_dir).
	DefaultWorkspaceDir string
	// Switch is the run's workspace: workspace_use moves it, and the run's tools follow it.
	Switch *pathroots.WorkspaceSwitch
	// UserText is what the user wrote for this task: a path named there may be used even when the
	// agent does not know it yet.
	UserText string
	// StateDir is the agent's state folder, which is never a workspace.
	StateDir string
	// DenyPaths is tools.read_file.deny_paths; the protected state files are always denied too.
	DenyPaths []string
	// HomeDir shows paths under it with ~; "" shows them in full.
	HomeDir string
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

// New returns the tools for one owner Console chat run. They are deferred: found with tool_search
// when it is on, listed with the others when it is off.
func New(deps Deps) []tools.Tool {
	d := &deps
	return []tools.Tool{
		&workspaceListTool{deps: d},
		&workspaceUseTool{deps: d},
		&topicSearchTool{deps: d},
		&topicReadTool{deps: d},
	}
}

// Catalog is every tool here, built without dependencies, for listing their schemas.
func Catalog() []tools.Tool {
	return New(Deps{})
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// ownerTool is what every tool here shares: deferred, kept from subtasks, and checked at each call.
type ownerTool struct{}

func (ownerTool) Deferred() bool        { return true }
func (ownerTool) SubtaskExcluded() bool { return true }

// errNotOwnerRun is the error of a call from anywhere but the owner's own Console chat run.
func errNotOwnerRun(name string) error {
	return fmt.Errorf("%s is only for the owner's own Console chat runs; it cannot be used here", name)
}

// checkCall refuses a call that does not come from the run the tool was built for, as the owner,
// at the top level. Registration already keeps the tools from other runs; this holds even if a
// tool reached one some other way.
func checkCall(ctx context.Context, name string, deps *Deps) error {
	if deps == nil || strings.TrimSpace(deps.RunID) == "" {
		return errNotOwnerRun(name)
	}
	if audience.FromContext(ctx).Kind != audience.KindOwner {
		return errNotOwnerRun(name)
	}
	if agent.SubtaskDepthFromContext(ctx) > 0 {
		return errNotOwnerRun(name)
	}
	if llmstats.RunIDFromContext(ctx) != strings.TrimSpace(deps.RunID) {
		return errNotOwnerRun(name)
	}
	return nil
}

func schema(properties map[string]any, required ...string) string {
	s := map[string]any{"type": "object", "additionalProperties": false, "properties": properties}
	if len(required) > 0 {
		s["required"] = required
	}
	raw, _ := json.Marshal(s)
	return string(raw)
}

func prop(typ, description string) map[string]any {
	return map[string]any{"type": typ, "description": description}
}

func result(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func stringParam(params map[string]any, key string) string {
	v, _ := params[key].(string)
	return strings.TrimSpace(v)
}

func intParam(params map[string]any, key string) int {
	switch v := params[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	}
	return 0
}

// limitParam reads a limit, defaulting to def and capped at max.
func limitParam(params map[string]any, def, max int) int {
	n := intParam(params, "limit")
	if n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// rejectUnknown refuses parameters the tool does not take, so a mistyped one is not ignored.
func rejectUnknown(params map[string]any, known ...string) error {
	for key := range params {
		ok := false
		for _, name := range known {
			if key == name {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("unknown parameter: %s", key)
		}
	}
	return nil
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// cut keeps the first max runes of text, and says whether it cut.
func cut(text string, max int) (string, bool) {
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) <= max {
		return text, false
	}
	return strings.TrimSpace(string([]rune(text)[:max])) + "…", true
}

var errNoStore = errors.New("the Console's topics are unavailable here")

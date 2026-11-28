package ownertools

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/workspace"
)

const (
	WorkThreadName = "work_thread"

	threadTitleMaxRunes = 80
	threadTaskMaxRunes  = 20000
)

// ThreadRequest is a work thread the Solo run asks for: a new topic (TopicID "") named Title, or
// the existing topic TopicID, given Task to do in WorkspaceDir.
type ThreadRequest struct {
	TopicID      string
	Title        string
	Task         string
	WorkspaceDir string
	// OriginTaskID is the Solo task whose run starts the thread.
	OriginTaskID string
}

// ThreadStarted is the thread's task as it was submitted.
type ThreadStarted struct {
	TopicID   string
	TaskID    string
	Title     string
	Workspace string
	Continued bool
}

// ThreadStarter submits a work thread's task to the runtime's own task queue, records the thread's
// card in Solo, and returns without waiting for the task.
type ThreadStarter func(ctx context.Context, req ThreadRequest) (ThreadStarted, error)

// NewWorkThread returns work_thread for one Solo run. It starts work in a topic of its own, in a
// workspace the owner knows or named, and leaves Solo free for the next message.
func NewWorkThread(deps Deps, start ThreadStarter) *WorkThreadTool {
	d := deps
	return &WorkThreadTool{deps: &d, start: start}
}

// WorkThreadTool is work_thread.
type WorkThreadTool struct {
	ownerTool
	deps  *Deps
	start ThreadStarter
}

func (t *WorkThreadTool) Name() string { return WorkThreadName }

// Deferred is false: work_thread is how Solo hands off work, so a Solo run always sees it.
func (t *WorkThreadTool) Deferred() bool { return false }

// CodeModeExcluded: starting a thread is a decision the model makes directly, one call at a time.
func (t *WorkThreadTool) CodeModeExcluded() bool { return true }

func (t *WorkThreadTool) Description() string {
	return "Starts a work thread: an ordinary topic of the owner's, with its own workspace, where a task you describe runs in the background while Solo stays free for the next message. " +
		"Use it for work that needs a project folder or will take more than a short while. The thread does not see this conversation: task must say everything it needs. " +
		"workspace is required: a workspace from workspace_list (or a folder inside one), or a folder the user named in this message; when it is not clear which one the work belongs to, ask the user instead of guessing. " +
		"Pass topic_id (from an earlier work_thread or topic_search) to give an existing thread more work in its own workspace. " +
		"It returns at once with the thread's topic and task IDs; the thread's card in Solo shows its state and its summary arrives here when it ends, so do not wait for it. " +
		"The thread works in that workspace as its own, without a further approval for it: choosing the workspace is what authorizes it, so choose with care."
}

func (t *WorkThreadTool) ParameterSchema() string {
	return schema(map[string]any{
		"title":     prop("string", "The thread's title, a few words naming the work. Required for a new thread."),
		"task":      prop("string", "What the thread should do, complete and self-contained: the goal, what to look at, what to report back."),
		"workspace": prop("string", "The thread's workspace folder: an absolute path or one starting with ~/."),
		"topic_id":  prop("string", "An existing thread's topic ID, to give it more work instead of starting a new one."),
	}, "task", "workspace")
}

func (t *WorkThreadTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if err := checkCall(ctx, t.Name(), t.deps); err != nil {
		return "", err
	}
	if err := rejectUnknown(params, "title", "task", "workspace", "topic_id"); err != nil {
		return "", err
	}
	if t.start == nil {
		return "", errNotOwnerRun(t.Name())
	}
	task := stringParam(params, "task")
	if task == "" {
		return "", fmt.Errorf("task is required")
	}
	if utf8.RuneCountInString(task) > threadTaskMaxRunes {
		return "", fmt.Errorf("task is too long (at most %d characters)", threadTaskMaxRunes)
	}
	title := strings.Join(strings.Fields(stringParam(params, "title")), " ")
	if utf8.RuneCountInString(title) > threadTitleMaxRunes {
		title = string([]rune(title)[:threadTitleMaxRunes])
	}
	topicID := stringParam(params, "topic_id")
	if topicID == "" && title == "" {
		return "", fmt.Errorf("title is required for a new thread")
	}
	dir, err := t.deps.threadWorkspace(stringParam(params, "workspace"))
	if err != nil {
		return "", err
	}
	if topicID != "" {
		if err := t.deps.checkThreadTopic(ctx, topicID, dir); err != nil {
			return "", err
		}
	}
	started, err := t.start(ctx, ThreadRequest{
		TopicID:      topicID,
		Title:        title,
		Task:         task,
		WorkspaceDir: dir,
		OriginTaskID: strings.TrimSpace(t.deps.RunID),
	})
	if err != nil {
		return "", err
	}
	out := map[string]any{
		"topic_id":  started.TopicID,
		"task_id":   started.TaskID,
		"title":     started.Title,
		"workspace": started.Workspace,
		"state":     daemonruntime.SoloThreadRunning,
		"continued": started.Continued,
		"note":      "The thread runs in the background. Tell the user briefly what it does; its card in Solo shows its state, and its summary comes to Solo when it ends. Do not wait for it or check on it now.",
	}
	return result(out)
}

// threadWorkspace checks a thread's workspace as workspace_use checks a switch: an existing folder
// the agent may use (not denied, not its state), and one it knows or the user named in this message.
func (d *Deps) threadWorkspace(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("workspace is required: ask the user which project folder the work belongs to when it is not clear")
	}
	target := pathutil.ExpandHomePath(raw)
	if !filepath.IsAbs(target) {
		return "", fmt.Errorf("workspace %q is not an absolute path; give the full path (see workspace_list)", raw)
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
		return "", fmt.Errorf("%s is not a workspace you know (see workspace_list) nor a folder the user named in this message; ask the user which workspace to use", displayPath(dir, d.HomeDir))
	}
	return dir, nil
}

// checkThreadTopic refuses an existing topic Solo may not give work to: one that is gone, one the
// runtime keeps for itself (Solo, Awareness, TODO items', agents'), or one that works in another
// workspace than the one asked for.
func (d *Deps) checkThreadTopic(ctx context.Context, topicID, dir string) error {
	if daemonruntime.IsReservedTopicID(topicID) {
		return fmt.Errorf("%s is not a topic a work thread can run in; start a new thread instead", topicID)
	}
	if d.Topics == nil {
		return errNoStore
	}
	topic, ok := d.Topics.GetTopic(topicID)
	if !ok || topic == nil || topic.DeletedAt != nil || topic.ID != topicID {
		return fmt.Errorf("no topic %s", topicID)
	}
	if d.TopicWorkspace == nil {
		return nil
	}
	current, _, err := d.TopicWorkspace(ctx, topicID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(current) != "" && !sameRealDir(current, dir) {
		return fmt.Errorf("topic %s works in %s, not %s; pass its own workspace, or start a new thread for the other one", topicID, displayPath(current, d.HomeDir), displayPath(dir, d.HomeDir))
	}
	return nil
}

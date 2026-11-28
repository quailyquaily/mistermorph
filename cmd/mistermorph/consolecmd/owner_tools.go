package consolecmd

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/ownertools"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools"
)

// consoleOwnerChatRun reports whether a Console task is the owner's own chat run: sent from the
// Console chat (or chat), in one of the owner's topics. Only such runs get the tools that reach
// other topics and workspaces (internal/ownertools). TODO items' runs, the Awareness topic, what
// an Agent Link agent sends and wake-ups do not, nor do the subtasks of any run.
func consoleOwnerChatRun(job consoleLocalTaskJob) bool {
	if !consoleAsksUser(job.Trigger) || !job.WakeSignal.IsZero() {
		return false
	}
	topicID := strings.TrimSpace(job.TopicID)
	switch {
	case daemonruntime.IsCronTopicID(topicID), daemonruntime.IsAgentLinkTopicID(topicID):
		return false
	case topicID == daemonruntime.ConsoleAwarenessTopicID:
		return false
	}
	return true
}

// ownerTools builds workspace_list, workspace_use, topic_search and topic_read for one owner chat
// run, bound to its task ID and its workspace switch.
func (r *consoleLocalRuntime) ownerTools(generation *consoleLocalRuntimeGeneration, job consoleLocalTaskJob, sw *pathroots.WorkspaceSwitch) []tools.Tool {
	if r == nil || generation == nil || sw == nil {
		return nil
	}
	return ownertools.New(r.ownerToolDeps(generation, job, sw))
}

// ownerToolDeps is what the owner tools of one run use.
func (r *consoleLocalRuntime) ownerToolDeps(generation *consoleLocalRuntimeGeneration, job consoleLocalTaskJob, sw *pathroots.WorkspaceSwitch) ownertools.Deps {
	reader := generation.reader
	defaultDir := ""
	var denyPaths []string
	if reader != nil {
		defaultDir = strings.TrimSpace(reader.GetString("workspace_dir"))
		denyPaths = reader.GetStringSlice("tools.read_file.deny_paths")
	}
	deps := ownertools.Deps{
		RunID:      job.TaskID,
		Workspaces: r.currentWorkspaceStore(),
		TopicWorkspace: func(ctx context.Context, topicID string) (string, string, error) {
			res, err := r.workspaceForTopic(ctx, topicID, defaultDir)
			return res.WorkspaceDir, res.Source, err
		},
		DefaultWorkspaceDir: defaultDir,
		Switch:              sw,
		UserText:            job.Task,
		StateDir:            generation.paths.StateDir,
		DenyPaths:           denyPaths,
		HomeDir:             workspace.HostHomeDir(),
	}
	if r.store != nil {
		deps.Topics = r.store
	}
	return deps
}

// ownerToolsPromptBlock tells an owner chat run when to reach past its own topic and workspace.
func ownerToolsPromptBlock() agent.PromptBlock {
	return agent.PromptBlock{Content: "## Other Topics and Workspaces\n\n" +
		"This is the owner's own Console chat. When the user refers to another conversation or to earlier work you cannot see here, find it with topic_search and read it with topic_read. " +
		"When the task needs another project folder, see the known ones with workspace_list and switch this task to one with workspace_use: your file and shell tools then work there for the rest of the task, and the topic's attached workspace does not change. " +
		"Find these tools with tool_search when they are not listed."}
}

// recordWorkspaceUse notes that a run started in dir, for workspace_list's recent workspaces.
func (r *consoleLocalRuntime) recordWorkspaceUse(dir string) {
	dir = strings.TrimSpace(dir)
	if r == nil || dir == "" {
		return
	}
	if err := r.currentWorkspaceStore().RecordUse(dir, time.Now()); err != nil {
		r.currentLogger().Warn("console_workspace_use_record_failed", "error", err.Error())
	}
}

// workspaceUseActivitySummary is what a finished workspace_use shows in the run's activity:
// "Using ~/proj/api".
func workspaceUseActivitySummary(event agent.Event) string {
	if strings.TrimSpace(event.ToolName) != ownertools.WorkspaceUseName || strings.TrimSpace(event.Error) != "" {
		return ""
	}
	var out struct {
		Activity string `json:"activity"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(event.Text)), &out) != nil {
		return ""
	}
	return strings.TrimSpace(out.Activity)
}

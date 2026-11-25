package consolecmd

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
)

func TestConsoleOwnerChatRun(t *testing.T) {
	chat := daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: consoleChatTriggerRef}
	cases := []struct {
		name string
		job  consoleLocalTaskJob
		want bool
	}{
		{"console chat", consoleLocalTaskJob{TopicID: "t1", Trigger: chat}, true},
		{"cli chat", consoleLocalTaskJob{TopicID: "t1", Trigger: daemonruntime.TaskTrigger{Source: "ui", Ref: consoleCLIChatTriggerRef}}, true},
		{"default topic", consoleLocalTaskJob{TopicID: daemonruntime.ConsoleDefaultTopicID, Trigger: chat}, true},
		{"other ui task", consoleLocalTaskJob{TopicID: "t1", Trigger: daemonruntime.TaskTrigger{Source: "ui", Ref: "web/console"}}, false},
		{"agent link reply", consoleLocalTaskJob{TopicID: "t1", Trigger: daemonruntime.TaskTrigger{Source: "agentlink", Ref: consoleChatTriggerRef}}, false},
		{"todo topic", consoleLocalTaskJob{TopicID: daemonruntime.CronTopicID("j1"), Trigger: chat}, false},
		{"agent link topic", consoleLocalTaskJob{TopicID: daemonruntime.AgentLinkTopicPrefix + "peer", Trigger: chat}, false},
		{"awareness topic", consoleLocalTaskJob{TopicID: daemonruntime.ConsoleAwarenessTopicID, Trigger: chat}, false},
		{"wake-up", consoleLocalTaskJob{TopicID: "t1", Trigger: chat, WakeSignal: awarenessdomain.PokeInput{HasBody: true, BodyText: "x"}}, false},
	}
	for _, c := range cases {
		if got := consoleOwnerChatRun(c.job); got != c.want {
			t.Errorf("%s: consoleOwnerChatRun = %v, want %v", c.name, got, c.want)
		}
	}
}

func ownerToolActivity(t *testing.T, rt *consoleLocalRuntime, job consoleLocalTaskJob) map[string]consoleActivityEntry {
	t.Helper()
	frames, unsubscribe := rt.streamHub.Subscribe(job.TaskID)
	defer unsubscribe()
	rt.handleTaskJob(context.Background(), job.ConversationKey, job)
	var live *consoleActivityProgress
drain:
	for {
		select {
		case frame := <-frames:
			if frame.Activity != nil {
				live = frame.Activity
			}
		default:
			break drain
		}
	}
	if live == nil {
		t.Fatal("no activity")
	}
	out := map[string]consoleActivityEntry{}
	for _, entry := range live.History {
		out[entry.Name] = entry
	}
	return out
}

func TestOwnerChatRunSwitchesWorkspaceAndSearchesTopics(t *testing.T) {
	root := t.TempDir()
	topicWS := filepath.Join(root, "topic-ws")
	other := filepath.Join(root, "other")
	for _, dir := range []string{topicWS, other} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	rt, job, _ := newConsoleProgressPersistenceRuntime(t, []consoleProgressPersistenceLLMStep{
		{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "c1", Name: "workspace_use", Arguments: map[string]any{"path": other}}}}},
		{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "c2", Name: "topic_search", Arguments: map[string]any{"query": "elsewhere"}}}}},
		{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "c3", Name: "workspace_list", Arguments: map[string]any{}}}}},
		{result: llm.Result{Text: `{"type":"final","output":"done"}`}},
	}, "work", false)
	ws := workspace.NewStore(filepath.Join(root, "state", "workspace_attachments.json"))
	rt.workspaceStore = ws
	job.Trigger = daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: consoleChatTriggerRef}
	job.WorkspaceDir = topicWS
	if _, _, err := ws.Set(job.ConversationKey, workspace.Attachment{WorkspaceDir: topicWS}); err != nil {
		t.Fatal(err)
	}
	elsewhere, err := rt.store.CreateNamedTopic("Work elsewhere")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ws.Set(buildConsoleConversationKey(elsewhere.ID), workspace.Attachment{WorkspaceDir: other}); err != nil {
		t.Fatal(err)
	}

	entries := ownerToolActivity(t, rt, job)
	use, ok := entries["workspace_use"]
	if !ok || use.Error != "" || !strings.HasPrefix(use.Summary, "Using ") || !strings.HasSuffix(use.Summary, "other") {
		t.Fatalf("workspace_use activity = %+v", use)
	}
	if search, ok := entries["topic_search"]; !ok || search.Error != "" {
		t.Fatalf("topic_search activity = %+v", search)
	}
	if list, ok := entries["workspace_list"]; !ok || list.Error != "" {
		t.Fatalf("workspace_list activity = %+v", list)
	}
	// The topic keeps its attachment; both workspaces are now recent uses.
	if dir, err := workspace.LookupWorkspaceDir(ws, job.ConversationKey); err != nil || dir != topicWS {
		t.Fatalf("attachment = %q, %v", dir, err)
	}
	uses, err := ws.RecentUses(10)
	if err != nil || len(uses) != 2 {
		t.Fatalf("uses = %+v, %v", uses, err)
	}
	if task, ok := rt.store.Get(job.TaskID); !ok || task.Status != daemonruntime.TaskDone {
		t.Fatalf("task = %+v", task)
	}
}

func TestOtherConsoleRunsDoNotGetOwnerTools(t *testing.T) {
	for name, trigger := range map[string]daemonruntime.TaskTrigger{
		"agent link":    {Source: "agentlink", Event: "reply"},
		"other ui task": {Source: "ui", Ref: "web/console"},
	} {
		t.Run(name, func(t *testing.T) {
			rt, job, _ := newConsoleProgressPersistenceRuntime(t, []consoleProgressPersistenceLLMStep{
				{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "c1", Name: "topic_search", Arguments: map[string]any{"query": "x"}}}}},
				{result: llm.Result{Text: `{"type":"final","output":"done"}`}},
			}, "work", false)
			job.Trigger = trigger
			entries := ownerToolActivity(t, rt, job)
			if search := entries["topic_search"]; search.Error == "" {
				t.Fatalf("topic_search ran in a %s run: %+v", name, search)
			}
		})
	}
}

func TestSendFileFollowsTheSwitchedWorkspace(t *testing.T) {
	tool, _ := attachmentFixture(t)
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "report.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	sw := pathroots.NewWorkspaceSwitch(tool.workspaceDir)
	ctx := pathroots.WithWorkspaceSwitch(context.Background(), sw)
	if _, err := tool.Execute(ctx, map[string]any{"dir_name": "workspace_dir", "path": "report.txt"}); err == nil {
		t.Fatal("sent a file the topic's workspace does not have")
	}
	sw.Use(other)
	if _, err := tool.Execute(ctx, map[string]any{"dir_name": "workspace_dir", "path": "report.txt"}); err != nil {
		t.Fatalf("send_file after the switch: %v", err)
	}
}

func TestWorkspaceUseActivitySummary(t *testing.T) {
	event := agent.Event{Kind: agent.EventKindToolDone, ToolName: "workspace_use", Text: `{"activity":"Using ~/proj/api"}`}
	if got := workspaceUseActivitySummary(event); got != "Using ~/proj/api" {
		t.Fatalf("summary = %q", got)
	}
	event.Error = "refused"
	if got := workspaceUseActivitySummary(event); got != "" {
		t.Fatalf("failed call summary = %q", got)
	}
}

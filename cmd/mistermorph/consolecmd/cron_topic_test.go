package consolecmd

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
)

func cronTopicNamingGeneration(icon string, calls *atomic.Int32, prompts chan<- string) *consoleLocalRuntimeGeneration {
	return &consoleLocalRuntimeGeneration{commonDeps: depsutil.CommonDependencies{
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) {
			return llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Model: "test"}}, nil
		},
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) {
			return topicNamingClientFunc(func(_ context.Context, req llm.Request) (llm.Result, error) {
				calls.Add(1)
				if prompts != nil {
					prompts <- req.Messages[1].Content
				}
				return llm.Result{Text: `{"title":"A generated name","icon":"` + icon + `"}`}, nil
			}), nil
		},
	}}
}

func TestRegenerateTodoTopicKeepsTheItemsTitle(t *testing.T) {
	store, _ := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	topicID := daemonruntime.CronTopicID("weekly")
	if err := store.UpsertWithTrigger(daemonruntime.TaskInfo{ID: "run", TopicID: topicID, Task: "Write the weekly report", Status: daemonruntime.TaskDone}, daemonruntime.TaskTrigger{}, "Weekly report"); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	rt := &consoleLocalRuntime{store: store}
	updated, err := rt.regenerateTopicTitle(context.Background(), cronTopicNamingGeneration("code", &calls, nil), topicID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Title != "Weekly report" || updated.Icon != "code" || calls.Load() != 1 {
		t.Fatalf("updated = %+v, calls = %d", updated, calls.Load())
	}
}

func TestTodoTopicGetsItsIconFromItsTaskOnce(t *testing.T) {
	store, _ := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	topicID := daemonruntime.CronTopicID("weekly")
	if err := store.UpsertWithTrigger(daemonruntime.TaskInfo{ID: "run", TopicID: topicID, Task: "Write the weekly report"}, daemonruntime.TaskTrigger{}, "Weekly report"); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	prompts := make(chan string, 2)
	generation := cronTopicNamingGeneration("code", &calls, prompts)
	rt := &consoleLocalRuntime{store: store}

	rt.maybeGenerateCronTopicIcon(generation, topicID, "Write the weekly report")
	select {
	case prompt := <-prompts:
		if !strings.Contains(prompt, "Write the weekly report") {
			t.Fatalf("prompt = %q, want the item's task", prompt)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no icon was generated")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		topic, _ := store.GetTopic(topicID)
		if topic.LLMTitleGeneratedAt != nil {
			if topic.Icon != "code" || topic.Title != "Weekly report" {
				t.Fatalf("topic = %+v", topic)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the icon did not land")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// The next run leaves it, as the next message does in a person's topic.
	rt.maybeGenerateCronTopicIcon(generation, topicID, "Write the weekly report")
	// A topic that is not a TODO item's is not this path's to name.
	rt.maybeGenerateCronTopicIcon(generation, "topic_a", "Hello")
	time.Sleep(20 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}

func TestTodoTopicWorkspaceComesFromTheItem(t *testing.T) {
	root := t.TempDir()
	cronPath := filepath.Join(root, "cron.yaml")
	itemDir := filepath.Join(root, "item-workspace")
	defaultDir := filepath.Join(root, "default-workspace")
	attachedDir := filepath.Join(root, "attached-workspace")
	for _, dir := range []string{itemDir, defaultDir, attachedDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cronFile := "version: 1\ntasks:\n" +
		"  - id: with-dir\n    at: \"2030-01-01 09:00\"\n    tz: UTC\n    content: run\n    workspace_dir: " + itemDir + "\n" +
		"  - id: no-dir\n    at: \"2030-01-01 09:00\"\n    tz: UTC\n    content: run\n"
	if err := os.WriteFile(cronPath, []byte(cronFile), 0o600); err != nil {
		t.Fatal(err)
	}
	store := workspace.NewStore(filepath.Join(root, "workspace_attachments.json"))
	// An attachment plays no part: a run never reads it.
	if _, _, err := store.Set("console:"+daemonruntime.CronTopicID("no-dir"), workspace.Attachment{WorkspaceDir: attachedDir}); err != nil {
		t.Fatal(err)
	}
	rt := &consoleLocalRuntime{
		workspaceStore: store,
		generation:     &consoleLocalRuntimeGeneration{paths: runtimepaths.Paths{CronPath: cronPath}},
	}

	for _, tt := range []struct {
		name, taskID, defaultDir, wantDir, wantSource string
	}{
		{"set on the item", "with-dir", defaultDir, itemDir, "todo"},
		{"default when the item sets none", "no-dir", defaultDir, defaultDir, "default"},
		{"none without a default", "no-dir", "", "", "none"},
		{"item gone, no run recorded", "gone", defaultDir, "", "none"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := rt.workspaceForTopic(context.Background(), daemonruntime.CronTopicID(tt.taskID), tt.defaultDir)
			if err != nil {
				t.Fatal(err)
			}
			if got.WorkspaceDir != tt.wantDir || got.Source != tt.wantSource {
				t.Fatalf("got %+v, want %q from %q", got, tt.wantDir, tt.wantSource)
			}
		})
	}

	// A one-time item is gone once it has run: its topic keeps the workspace the run was given.
	finished := daemonruntime.CronTopicID("finished")
	rt.store, _ = daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	rt.recordCronTopicRun(nil, awareness.TopicRun{TopicID: finished, WorkspaceDir: itemDir})
	got, err := rt.workspaceForTopic(context.Background(), finished, defaultDir)
	if err != nil || got.WorkspaceDir != itemDir || got.Source != "todo" {
		t.Fatalf("finished item: %+v, %v", got, err)
	}
	// A later run of an item that sets none leaves nothing behind.
	rt.recordCronTopicRun(nil, awareness.TopicRun{TopicID: finished})
	if got, err := rt.workspaceForTopic(context.Background(), finished, defaultDir); err != nil || got.WorkspaceDir != "" {
		t.Fatalf("finished item without a workspace: %+v, %v", got, err)
	}

	topicID := daemonruntime.CronTopicID("with-dir")
	if _, err := rt.setWorkspaceForTopic(context.Background(), topicID, attachedDir); err == nil || !strings.Contains(err.Error(), consoleCronTopicWorkspaceFixed) {
		t.Fatalf("attaching to a TODO item's topic: error = %v", err)
	}
	if _, err := rt.deleteWorkspaceForTopic(context.Background(), topicID, defaultDir); err == nil || !strings.Contains(err.Error(), consoleCronTopicWorkspaceFixed) {
		t.Fatalf("detaching from a TODO item's topic: error = %v", err)
	}
	// A person's topic still attaches as before.
	if got, err := rt.setWorkspaceForTopic(context.Background(), "topic_a", attachedDir); err != nil || got.WorkspaceDir == "" {
		t.Fatalf("person's topic: %+v, %v", got, err)
	}
}

package chatcmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/contextcheckpoint"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

func TestLocalChatExecutesAndPersistsWithoutConsole(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)
	configdefaults.Apply(viper.GetViper())
	requests := make(chan string, 2)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests <- string(body)
		output := `{"type":"final","output":"local execution answer","is_lightweight":false}`
		if strings.Contains(string(body), "simulate missing approval") {
			output = `{"type":"final","output":{"status":"pending","approval_request_id":"missing"},"is_lightweight":false}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": output}, "finish_reason": "stop"}}})
	}))
	defer provider.Close()
	state, work := t.TempDir(), t.TempDir()
	for key, value := range map[string]any{
		"file_state_dir": state, "file_cache_dir": t.TempDir(), "workspace_dir": work,
		"llm.provider": "openai", "llm.model": "test-model", "llm.endpoint": provider.URL + "/v1", "llm.api_key": "test-key",
		"console.listen": strings.TrimPrefix(provider.URL, "http://"), "skills.enabled": false, "guard.enabled": false, "logging.file.enabled": false,
	} {
		viper.Set(key, value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := New(Dependencies{})
	cmd.SetContext(ctx)
	input, writer := io.Pipe()
	defer input.Close()
	defer writer.Close()
	cmd.SetIn(input)
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	sess, err := buildChatSession(cmd, Dependencies{RegistryFromViper: tools.NewRegistry})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sess.cleanup)
	if err := sess.openLocalTopics(""); err != nil {
		t.Fatal(err)
	}
	model := newChatModel(sess)
	model.historyPath = filepath.Join(t.TempDir(), "input-history")
	done := make(chan error, 1)
	runErrors := make(chan error, 4)
	go func() {
		done <- runREPL(sess, model, tea.WithoutRenderer(), tea.WithInput(nil), tea.WithoutSignalHandler(), tea.WithFilter(func(_ tea.Model, msg tea.Msg) tea.Msg {
			if result, ok := msg.(agentResultMsg); ok && result.err != nil {
				runErrors <- result.err
			}
			return msg
		}))
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("chat did not stop")
		}
	})
	model.submitted <- "hello without Console"
	select {
	case request := <-requests:
		if !strings.Contains(request, "hello without Console") {
			t.Fatalf("wrong provider request: %s", request)
		}
	case err := <-done:
		done <- err
		t.Fatalf("chat exited before executing: %v", err)
	case err := <-runErrors:
		t.Fatalf("chat execution failed: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for {
		tasks := sess.sharedTopics.List(daemonruntime.TaskListOptions{Limit: 10})
		if len(tasks) == 1 && tasks[0].Status == daemonruntime.TaskDone {
			if got := chathistory.TaskReplyText(tasks[0]); got != "local execution answer" {
				t.Fatal(got)
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(fmt.Sprintf("local result was not saved: %+v", tasks))
		case <-time.After(10 * time.Millisecond):
		}
	}
	if _, err := os.Stat(filepath.Join(state, "console", "runtime.json")); !os.IsNotExist(err) {
		t.Fatalf("local chat created a Console connection: %v", err)
	}
	topicID := sess.sharedTopics.List(daemonruntime.TaskListOptions{Limit: 1})[0].TopicID
	attachments := workspace.NewStore(filepath.Join(state, "workspace_attachments.json"))
	nextWorkspace := t.TempDir()
	model.submitted <- "/workspace attach " + nextWorkspace
	for {
		attachment, _, err := attachments.Get("console:" + topicID)
		if err != nil {
			t.Fatal(err)
		}
		if attachment.WorkspaceDir == nextWorkspace {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("workspace change was not shared")
		case <-time.After(10 * time.Millisecond):
		}
	}
	web, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{RootDir: filepath.Join(state, "tasks", "console"), JournalDir: filepath.Join(state, "journal"), Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := web.Upsert(daemonruntime.TaskInfo{ID: "web-reply", TopicID: topicID, Task: "question from Web", Status: daemonruntime.TaskDone, CreatedAt: now, FinishedAt: &now, Result: map[string]any{"final": map[string]any{"output": "answer from Web"}}}); err != nil {
		t.Fatal(err)
	}
	model.submitted <- "continue shared conversation"
	select {
	case request := <-requests:
		for _, want := range []string{"hello without Console", "local execution answer", "question from Web", "answer from Web", "continue shared conversation"} {
			if !strings.Contains(request, want) {
				t.Fatalf("provider did not receive shared context %q", want)
			}
		}
	case err := <-runErrors:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for {
		tasks := web.List(daemonruntime.TaskListOptions{TopicID: topicID, Limit: 1})
		if len(tasks) == 1 && tasks[0].Task == "continue shared conversation" && tasks[0].Status == daemonruntime.TaskDone {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("second turn did not complete")
		case <-time.After(10 * time.Millisecond):
		}
	}
	model.submitted <- "simulate missing approval"
	select {
	case <-runErrors:
	case <-ctx.Done():
		t.Fatal("missing approval was not reported")
	}
	if tasks := web.List(daemonruntime.TaskListOptions{TopicID: topicID, Limit: 1}); len(tasks) != 1 || tasks[0].Status != daemonruntime.TaskFailed {
		t.Fatalf("missing approval blocked shared topic: %+v", tasks)
	}
}

func TestLocalChatCreatesAndContinuesSharedHistory(t *testing.T) {
	state, work := t.TempDir(), t.TempDir()
	sess := &chatSession{fileStateDir: state, workspaceDir: work, rootContext: context.Background()}
	if err := sess.openLocalTopics(""); err != nil {
		t.Fatal(err)
	}
	defer sess.closeLocalTopics()
	if sess.topicID != "" {
		t.Fatal("opening chat created an empty topic")
	}
	first, err := sess.startLocalTask("local-1", "hello from chat")
	if err != nil {
		t.Fatal(err)
	}
	if first.TopicID == "" || sess.conversationKey() != "console:"+first.TopicID {
		t.Fatalf("not using shared topic: %+v", first)
	}
	if err := sess.recordLocalResult(chatTurnResult{turn: &activeChatTurn{sharedTask: &first}, final: &agent.Final{Output: "local answer"}}); err != nil {
		t.Fatal(err)
	}
	web, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{RootDir: filepath.Join(state, "tasks", "console"), JournalDir: filepath.Join(state, "journal"), Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	if task, ok := web.Get(first.ID); !ok || task.Status != daemonruntime.TaskDone || chathistory.TaskReplyText(*task) != "local answer" {
		t.Fatalf("Web cannot read chat result: %+v", task)
	}
	now := time.Now().UTC()
	if err := web.Upsert(daemonruntime.TaskInfo{ID: "web-1", TopicID: first.TopicID, Task: "continue in Web", Status: daemonruntime.TaskDone, CreatedAt: now, FinishedAt: &now, Result: map[string]any{"final": map[string]any{"output": "Web answer"}}}); err != nil {
		t.Fatal(err)
	}
	second, err := sess.startLocalTask("local-2", "continue in chat")
	if err != nil {
		t.Fatal(err)
	}
	history, boundaries, boundary, err := sess.localTopicHistory(second)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 4 || history[0].Content != "hello from chat" || history[3].Content != "Web answer" || len(boundaries) != len(history) {
		t.Fatalf("shared history = %+v / %v", history, boundaries)
	}
	if boundary != chathistory.BoundaryForItem(chathistory.TaskInbound(second)) {
		t.Fatal("chat and Web use different checkpoint boundaries")
	}
	active := &activeChatTurn{sharedTask: &second, steerQueue: runtimecontrol.NewSteerQueue(1)}
	if err := sess.queueLocalSteer(active, "follow this instruction"); err != nil {
		t.Fatal(err)
	}
	if err := sess.queueLocalSteer(active, "queue is full"); err == nil {
		t.Fatal("accepted full queue")
	}
	if got := active.steerQueue.Drain(); len(got) != 1 || got[0] != "follow this instruction" {
		t.Fatalf("steer queue: %v", got)
	}
	var steered bool
	for _, task := range web.List(daemonruntime.TaskListOptions{TopicID: second.TopicID, Limit: 20}) {
		if task.Task == "follow this instruction" {
			steered = task.SteerTargetTaskID == second.ID && task.Status == daemonruntime.TaskDone
		}
		if task.Task == "queue is full" && task.Status == daemonruntime.TaskDone {
			t.Fatal("failed steer recorded as accepted")
		}
	}
	if !steered {
		t.Fatal("Web cannot read steer history")
	}
	if err := sess.recordLocalResult(chatTurnResult{turn: &activeChatTurn{sharedTask: &second}, err: context.Canceled}); err != nil {
		t.Fatal(err)
	}
	if task, _ := web.Get(second.ID); task == nil || task.Status != daemonruntime.TaskCanceled {
		t.Fatalf("cancel was not shared: %+v", task)
	}
}

func TestLocalTopicSelectionAndResetUseSharedWorkspaceAndHistory(t *testing.T) {
	state, work := t.TempDir(), t.TempDir()
	first := &chatSession{fileStateDir: state, workspaceDir: work, rootContext: context.Background()}
	if err := first.openLocalTopics(""); err != nil {
		t.Fatal(err)
	}
	defer first.closeLocalTopics()
	task, err := first.startLocalTask("first", "remember this")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.recordLocalResult(chatTurnResult{turn: &activeChatTurn{sharedTask: &task}, final: &agent.Final{Output: "remembered"}}); err != nil {
		t.Fatal(err)
	}
	second := &chatSession{fileStateDir: state, workspaceDir: t.TempDir(), rootContext: context.Background()}
	if err := second.openLocalTopics(task.TopicID); err != nil {
		t.Fatal(err)
	}
	defer second.closeLocalTopics()
	if second.workspaceDir != work {
		t.Fatalf("topic workspace = %q, want shared workspace", second.workspaceDir)
	}
	if _, err := contextcheckpoint.NewFileStore(state, second.conversationKey()); err != nil {
		t.Fatal(err)
	}
	if err := second.selectLocalTopic("missing-topic"); err == nil {
		t.Fatal("selected missing topic")
	}
	if second.topicID != task.TopicID {
		t.Fatal("failed selection replaced active topic")
	}
	if err := second.resetLocalTopic(context.Background()); err != nil {
		t.Fatal(err)
	}
	next, err := second.startLocalTask("next", "after reset")
	if err != nil {
		t.Fatal(err)
	}
	history, _, _, err := second.localTopicHistory(next)
	if err != nil || len(history) != 0 {
		t.Fatalf("reset kept old context: %+v, %v", history, err)
	}
	if !strings.HasPrefix(second.conversationKey(), "console:") {
		t.Fatal("lost shared checkpoint scope")
	}
}

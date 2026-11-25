package chatcmd

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
)

func TestLocalTopicCommandsShareSelectionHistoryAndDeletion(t *testing.T) {
	sess := &chatSession{fileStateDir: t.TempDir(), workspaceDir: t.TempDir(), rootContext: context.Background()}
	if err := sess.openLocalTopics(""); err != nil {
		t.Fatal(err)
	}
	defer sess.closeLocalTopics()
	task, err := sess.startLocalTask("first", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.recordLocalResult(chatTurnResult{turn: &activeChatTurn{sharedTask: &task}, final: &agent.Final{Output: "answer"}}); err != nil {
		t.Fatal(err)
	}
	other, err := sess.sharedTopics.CreateTopic("other workspace")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := sess.sharedWorkspaces.Set("console:"+other.ID, workspace.Attachment{WorkspaceDir: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	var messages []any
	sess.sendMsg = func(msg any) { messages = append(messages, msg) }
	reg := chatcommands.NewRegistry()
	var history []llm.Message
	var boundaries []string
	registerChatCommands(reg, sess, &history, &boundaries)
	for _, input := range []string{"/topics", "/topic new", "/topic switch " + task.TopicID, "/topic history"} {
		if _, handled, err := reg.Dispatch(context.Background(), input); !handled || err != nil {
			t.Fatalf("%s: handled=%v error=%v", input, handled, err)
		}
	}
	if sess.topicID != task.TopicID {
		t.Fatal("topic selection not applied")
	}
	var listed, restored bool
	for _, msg := range messages {
		switch msg := msg.(type) {
		case localTopicsMsg:
			listed = len(msg.items) == 1 && msg.items[0].ID == task.TopicID
		case localHistoryMsg:
			restored = restored || len(msg.tasks) == 1 && msg.tasks[0].ID == task.ID
		}
	}
	if !listed || !restored {
		t.Fatalf("listed=%v restored=%v", listed, restored)
	}
	sess.taskRuntime = &taskruntime.Runtime{BootstrapMainClient: localTopicTitleClient{t: t}, BootstrapMainModel: "test"}
	if _, _, err := reg.Dispatch(context.Background(), "/topic title regenerate"); err != nil {
		t.Fatal(err)
	}
	if got, _ := sess.sharedTopics.GetTopic(task.TopicID); got == nil || got.Title != "Shared conversation" {
		t.Fatalf("title=%+v", got)
	}
	if _, _, err := reg.Dispatch(context.Background(), "/topic delete"); err != nil {
		t.Fatal(err)
	}
	if got, _ := sess.sharedTopics.GetTopic(task.TopicID); got == nil || got.DeletedAt != nil {
		t.Fatal("deleted before confirmation")
	}
	if _, _, err := reg.Dispatch(context.Background(), "/topic delete confirm "+task.TopicID); err != nil {
		t.Fatal(err)
	}
	if got, _ := sess.sharedTopics.GetTopic(task.TopicID); got != nil && got.DeletedAt == nil {
		t.Fatal("topic not deleted")
	}
	if sess.topicID != "" {
		t.Fatal("deleted topic remains selected")
	}
}

func TestLocalTopicPaginationAfterWorkspaceFiltering(t *testing.T) {
	sess := &chatSession{fileStateDir: t.TempDir(), workspaceDir: t.TempDir(), rootContext: context.Background()}
	if err := sess.openLocalTopics(""); err != nil {
		t.Fatal(err)
	}
	defer sess.closeLocalTopics()
	other := t.TempDir()
	for i := range 90 {
		topic, err := sess.sharedTopics.CreateTopic(fmt.Sprintf("topic-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		dir := sess.workspaceDir
		if i%3 == 0 {
			dir = other
		}
		if _, _, err := sess.sharedWorkspaces.Set("console:"+topic.ID, workspace.Attachment{WorkspaceDir: dir}); err != nil {
			t.Fatal(err)
		}
	}
	var page localTopicsMsg
	sess.sendMsg = func(msg any) { page = msg.(localTopicsMsg) }
	seen := map[string]bool{}
	cursor := ""
	for range 4 {
		if _, err := sess.topicsCommand(cursor); err != nil {
			t.Fatal(err)
		}
		for _, item := range page.items {
			if seen[item.ID] {
				t.Fatal("duplicate topic")
			}
			seen[item.ID] = true
		}
		cursor = page.cursor
		if cursor == "" {
			break
		}
	}
	if len(seen) != 60 {
		t.Fatalf("pagination returned %d topics, want 60", len(seen))
	}
}

type localTopicTitleClient struct{ t *testing.T }

func (c localTopicTitleClient) Chat(_ context.Context, r llm.Request) (llm.Result, error) {
	if len(r.Messages) != 2 || !strings.Contains(r.Messages[1].Content, "answer") {
		c.t.Fatalf("missing conversation in title request: %+v", r)
	}
	return llm.Result{Text: `{"title":"Shared conversation","icon":"chat"}`}, nil
}

func TestLocalSoloCommandOpensTheSameSoloAsTheConsole(t *testing.T) {
	sess := &chatSession{fileStateDir: t.TempDir(), workspaceDir: t.TempDir(), rootContext: context.Background()}
	if err := sess.openLocalTopics(""); err != nil {
		t.Fatal(err)
	}
	defer sess.closeLocalTopics()
	var messages []any
	sess.sendMsg = func(msg any) { messages = append(messages, msg) }
	reg := chatcommands.NewRegistry()
	history := []llm.Message{{Role: "user", Content: "earlier"}}
	var boundaries []string
	registerChatCommands(reg, sess, &history, &boundaries)
	if _, handled, err := reg.Dispatch(context.Background(), "/solo"); !handled || err != nil {
		t.Fatalf("/solo: handled=%v error=%v", handled, err)
	}
	if sess.topicID != daemonruntime.ConsoleSoloTopicID || history != nil {
		t.Fatalf("topic=%q history=%v", sess.topicID, history)
	}
	solo, ok := sess.sharedTopics.GetTopic(daemonruntime.ConsoleSoloTopicID)
	if !ok || solo.Title != "Solo" {
		t.Fatalf("Solo = %+v", solo)
	}
	opened := false
	for _, msg := range messages {
		if h, ok := msg.(localHistoryMsg); ok && h.topic.ID == daemonruntime.ConsoleSoloTopicID {
			opened = true
		}
	}
	if !opened {
		t.Fatal("Solo's history was not shown")
	}
	// A message there lands in Solo; /topic switch by its ID opens the same conversation.
	task, err := sess.startLocalTask("solo-1", "hello Solo")
	if err != nil || task.TopicID != daemonruntime.ConsoleSoloTopicID {
		t.Fatalf("task = %+v, %v", task, err)
	}
	if _, _, err := reg.Dispatch(context.Background(), "/topic new"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := reg.Dispatch(context.Background(), "/topic switch "+daemonruntime.ConsoleSoloTopicID); err != nil || sess.topicID != daemonruntime.ConsoleSoloTopicID {
		t.Fatalf("switch to Solo: %v (%q)", err, sess.topicID)
	}
	if !strings.Contains(strings.Join(reg.Names(), " "), "/solo") {
		t.Fatal("/solo is not listed")
	}
}

package consolecmd

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

func TestConsoleCannotResolveLocalChatApproval(t *testing.T) {
	root := t.TempDir()
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{RootDir: filepath.Join(root, "console"), JournalDir: filepath.Join(root, "journal"), Persist: true, SkipRecovery: true})
	if err != nil {
		t.Fatal(err)
	}
	owner, release, err := store.AcquireChatSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	now := time.Now().UTC()
	if err := store.UpsertWithTrigger(daemonruntime.TaskInfo{ID: "local-task", TopicID: "local-topic", Status: daemonruntime.TaskPending, ApprovalRequestID: "local-approval", CreatedAt: now, PendingAt: &now}, daemonruntime.TaskTrigger{Source: "chat", Ref: owner}, ""); err != nil {
		t.Fatal(err)
	}
	runtime := &consoleLocalRuntime{store: store, consoleExecutionState: newConsoleExecutionState(nil, nil)}
	if _, err := runtime.approveApproval(context.Background(), daemonruntime.ApprovalDecisionRequest{ApprovalRequestID: "local-approval"}); err == nil {
		t.Fatal("Console tried to resume another process's approval")
	}
	if task, _ := store.Get("local-task"); task == nil || task.Status != daemonruntime.TaskPending || task.ApprovalRequestID != "local-approval" {
		t.Fatalf("Console changed local pending task: %+v", task)
	}
}

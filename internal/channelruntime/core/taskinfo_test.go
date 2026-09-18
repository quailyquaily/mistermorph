package core

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

type failingTaskUpdater struct {
	err error
}

func (s failingTaskUpdater) Update(string, func(*daemonruntime.TaskInfo)) error {
	return s.err
}

func TestTaskIDForPendingApprovalFindsOlderPage(t *testing.T) {
	store := daemonruntime.NewMemoryStore(300)
	base := time.Now().UTC()
	store.Upsert(daemonruntime.TaskInfo{
		ID:                "target_task",
		Status:            daemonruntime.TaskPending,
		CreatedAt:         base,
		ApprovalRequestID: "apr_target",
	})
	for i := 0; i < 201; i++ {
		store.Upsert(daemonruntime.TaskInfo{
			ID:                fmt.Sprintf("newer_%03d", i),
			Status:            daemonruntime.TaskPending,
			CreatedAt:         base.Add(time.Duration(i+1) * time.Second),
			ApprovalRequestID: fmt.Sprintf("apr_newer_%03d", i),
		})
	}

	if got := TaskIDForPendingApproval(store, "apr_target"); got != "target_task" {
		t.Fatalf("TaskIDForPendingApproval() = %q, want target_task", got)
	}
}

func TestMarkTaskDoneReturnsPersistenceError(t *testing.T) {
	want := errors.New("journal append failed")
	err := MarkTaskDone(failingTaskUpdater{err: want}, "task_1", "done")
	if !errors.Is(err, want) {
		t.Fatalf("MarkTaskDone() error = %v, want %v", err, want)
	}
}

func TestClearTaskPendingApprovalFieldsKeepsExecutionTrace(t *testing.T) {
	now := time.Now()
	for _, hasTrace := range []bool{false, true} {
		info := daemonruntime.TaskInfo{PendingAt: &now, ApprovalRequestID: "approval", Result: map[string]any{"final": "pending response"}}
		if hasTrace {
			info.Result.(map[string]any)["trace"] = "retained execution records"
		}
		ClearTaskPendingApprovalFields(&info)
		if info.PendingAt != nil || info.ApprovalRequestID != "" {
			t.Fatal("pending fields remain")
		}
		if hasTrace {
			result, ok := info.Result.(map[string]any)
			if !ok || len(result) != 1 || result["trace"] != "retained execution records" {
				t.Fatalf("lost trace or retained pending response: %#v", info.Result)
			}
		} else if info.Result != nil {
			t.Fatalf("pending response remains: %#v", info.Result)
		}
	}
}

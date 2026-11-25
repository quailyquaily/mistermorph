package taskruntime

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

// A function subtask (a coder's CLI) registers with its task's child steering while it runs, so
// a message for it is refused as one it cannot take, and as finished once it has returned.
func TestRuntimeSubtaskRegistersWithChildSteering(t *testing.T) {
	control := runtimecontrol.New()
	children := runtimecontrol.NewChildSteering()
	if err := control.Start(runtimecontrol.ActiveRun{Runtime: "console", ConversationKey: "topic", TaskID: "task_1", Children: children}); err != nil {
		t.Fatal(err)
	}
	ctx := agent.WithChildSteerHub(context.Background(), children)
	runtime := &Runtime{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	var workerID string
	var during runtimecontrol.ChildSteerResult
	result, err := runtime.RunSubtask(ctx, agent.SubtaskRequest{
		Task: "run codex",
		RunFunc: func(runCtx context.Context) (*agent.SubtaskResult, error) {
			workerID = agent.WorkerFromContext(runCtx).ID
			during = control.SteerChild("console", "topic", workerID, "stop that")
			return &agent.SubtaskResult{Status: agent.SubtaskStatusDone, Output: "ok"}, nil
		},
	})
	if err != nil || result.Status != agent.SubtaskStatusDone || len(result.UserMessages) != 0 {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
	if during.Reason != runtimecontrol.SteerRejectedChildUnsupported || during.ChildTaskID != result.TaskID {
		t.Fatalf("while running = %+v, want child_unsupported for %s", during, result.TaskID)
	}
	if after := control.SteerChild("console", "topic", result.TaskID, "stop that"); after.Reason != runtimecontrol.SteerRejectedChildUnsupported {
		t.Fatalf("after = %+v", after)
	}
}

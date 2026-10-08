package taskruntime

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestRuntimeSessionIDUsesConversationScope(t *testing.T) {
	client := &stubTaskRuntimeClient{}
	rt, err := NewRunPreparer(lifecycleTaskRuntimeDeps(func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil }), BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 1}})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	for _, tt := range []struct{ conversation, explicit, run, want string }{
		{"console:topic-a", "", "run-1", "console:topic-a"},
		{"console:topic-a", "", "run-2", "console:topic-a"},
		{"console:topic-b", "", "run-3", "console:topic-b"},
		{"console:topic-a", "custom-session", "run-4", "custom-session"},
		{"", "", "run-5", ""},
	} {
		ctx := llmstats.WithRunID(context.Background(), tt.run)
		ctx = topiccontext.WithScope(ctx, topiccontext.Scope{ConversationKey: tt.conversation})
		if _, err := rt.Run(ctx, RunRequest{Task: "work", SessionID: tt.explicit}); err != nil {
			t.Fatal(err)
		}
		if got := client.requests[len(client.requests)-1].SessionID; got != tt.want {
			t.Fatalf("session = %q, want %q", got, tt.want)
		}
	}
	parentCtx := topiccontext.WithScope(context.Background(), topiccontext.Scope{ConversationKey: "console:parent"})
	for range 2 {
		result, err := rt.RunSubtask(parentCtx, agent.SubtaskRequest{Task: "child", Registry: tools.NewRegistry()})
		if err != nil || result.Status != agent.SubtaskStatusDone {
			t.Fatalf("result = %#v, err = %v", result, err)
		}
	}
	children := client.requests[len(client.requests)-2:]
	if children[0].SessionID == "" || children[1].SessionID == "" || children[0].SessionID == "console:parent" || children[0].SessionID == children[1].SessionID {
		t.Fatalf("subtask sessions are not isolated: %#v", children)
	}
}

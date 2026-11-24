package awareness

import (
	"context"
	"log/slog"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/awarenessutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/configtools"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// A heartbeat or scheduled run has nobody to approve a config change: it never gets config_set,
// even from a registry that has it (the base registry, when a runtime has no awareness registry)
// or from triggered tools. config_get only reads, so it stays.
func TestAwarenessRunNeverHasConfigSet(t *testing.T) {
	opts := configtools.Options{ConfigPath: t.TempDir() + "/config.yaml"}
	base := tools.NewRegistry()
	_ = base.Register(configtools.NewGetTool(opts))
	_ = base.Register(configtools.NewSetTool(opts))
	client := &awarenessPromptCaptureClient{}
	_, err := runAwarenessTask(context.Background(), depsutil.CommonDependencies{
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.PromptSpec{Identity: "identity"}, nil, nil
		},
		RegisterTriggeredStaticTools: func(reg *tools.Registry, _ map[string]bool) {
			_ = reg.Replace(configtools.NewSetTool(opts))
		},
	}, awarenessTaskOptions{
		Behavior:     awarenessutil.BehaviorCron,
		Client:       client,
		Model:        "test-model",
		Task:         "Check the config.",
		BaseRegistry: base,
		Config:       agent.Config{MaxSteps: 1},
	})
	if err != nil || len(client.requests) != 1 {
		t.Fatalf("runAwarenessTask: %v, %d requests", err, len(client.requests))
	}
	var hasGet, hasSet bool
	for _, tool := range client.requests[0].Tools {
		hasGet = hasGet || tool.Name == configtools.GetToolName
		hasSet = hasSet || tool.Name == configtools.SetToolName
	}
	if !hasGet || hasSet {
		t.Fatalf("awareness run tools: config_get %v, config_set %v; want config_get only", hasGet, hasSet)
	}
}

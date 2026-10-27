package taskruntime

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/memorytools"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestPrepareRunRegistersMemoryToolsForAnAudience(t *testing.T) {
	root := t.TempDir()
	deps := lifecycleTaskRuntimeDeps(func(llmutil.ResolvedRoute) (llm.Client, error) {
		return &lifecycleTaskRuntimeClient{}, nil
	})
	deps.RuntimePaths = runtimepaths.Paths{
		StateDir:     root,
		JournalDir:   filepath.Join(root, "journal"),
		MemoryDBPath: filepath.Join(root, "memory.db"),
	}
	deps.Logger = func() (*slog.Logger, error) { return slog.Default(), nil }
	rt, err := NewRunPreparer(deps, BootstrapOptions{})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	defer func() { _ = rt.Close() }()

	enabled := toolsutil.RuntimeToolsRegisterConfig{Memories: toolsutil.MemoriesConfig{Enabled: true}}
	disabled := toolsutil.RuntimeToolsRegisterConfig{}
	for _, tc := range []struct {
		name    string
		ctx     context.Context
		cfg     toolsutil.RuntimeToolsRegisterConfig
		subtask bool
		want    []string
		absent  []string
	}{
		{"owner", audience.NewContext(context.Background(), audience.Owner()), enabled, false,
			[]string{memorytools.SaveName, memorytools.SearchName, memorytools.ForgetName, memorytools.JournalSearchName, memorytools.JournalReadName}, nil},
		{"read-only", WithMemoriesReadOnly(audience.NewContext(context.Background(), audience.Owner())), enabled, false,
			[]string{memorytools.SearchName, memorytools.JournalSearchName}, []string{memorytools.SaveName, memorytools.ForgetName}},
		{"no audience", context.Background(), enabled, false, nil, []string{memorytools.SaveName, memorytools.SearchName}},
		{"disabled", audience.NewContext(context.Background(), audience.Owner()), disabled, false, nil, []string{memorytools.SaveName}},
		{"subtask", audience.NewContext(context.Background(), audience.Owner()), enabled, true, nil, []string{memorytools.SaveName}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := tc.ctx
			if tc.subtask {
				ctx = agent.WithSubtaskDepth(ctx, 1)
			}
			reg := tools.NewRegistry()
			cfg := tc.cfg
			prepared, err := rt.PrepareEngine(ctx, RunRequest{Task: "ping", Registry: reg, RuntimeToolsConfig: &cfg})
			if err != nil {
				t.Fatalf("PrepareEngine() error = %v", err)
			}
			defer func() { _ = prepared.Cleanup() }()
			for _, name := range tc.want {
				if _, ok := reg.Get(name); !ok {
					t.Errorf("%s missing", name)
				}
			}
			for _, name := range tc.absent {
				if _, ok := reg.Get(name); ok {
					t.Errorf("%s registered, want absent", name)
				}
			}
		})
	}
}

package taskruntime

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/memories"
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

func TestMemoryReminder(t *testing.T) {
	store, err := memories.Open(context.Background(), filepath.Join(t.TempDir(), "memory.db"))
	if err != nil {
		t.Fatalf("memories.Open() error = %v", err)
	}
	defer store.Close()
	who := audience.Contact("tg:@alice")
	prepared := preparedRuntimeRun{memories: store, audience: who, logger: slog.Default()}
	// Failed and lightweight runs are not turns.
	prepared.countMemoryTurn(&agent.Final{Output: "x"}, errors.New("failed"))
	prepared.countMemoryTurn(&agent.Final{IsLightweight: true}, nil)
	for i := 0; i < MemoryReminderAfter-1; i++ {
		prepared.countMemoryTurn(&agent.Final{Output: "ok"}, nil)
	}
	hook := memoryReminderHook(store, who, slog.Default())
	messages := []llm.Message{{Role: "system", Content: "s"}, {Role: "user", Content: "hello"}}
	if err := hook(context.Background(), 0, nil, &messages); err != nil {
		t.Fatalf("hook() error = %v", err)
	}
	if strings.Contains(messages[1].Content, "Runtime Note") {
		t.Fatalf("reminder before the threshold: %q", messages[1].Content)
	}
	prepared.countMemoryTurn(&agent.Final{Output: "ok"}, nil)

	if err := hook(context.Background(), 1, nil, &messages); err != nil || strings.Contains(messages[1].Content, "Runtime Note") {
		t.Fatalf("reminder at a later step (a resumed run): %q, %v", messages[1].Content, err)
	}
	withImage := []llm.Message{{Role: "user", Parts: []llm.Part{{Type: llm.PartTypeImageURL, URL: "https://example.com/a.png"}}}}
	if err := hook(context.Background(), 0, nil, &withImage); err != nil {
		t.Fatalf("hook() error = %v", err)
	}
	if len(withImage[0].Parts) != 2 || !strings.Contains(withImage[0].Parts[1].Text, "memory_save") {
		t.Fatalf("reminder on a message with parts = %#v", withImage[0])
	}
	// Taken once per stretch: the next run gets no note.
	again := []llm.Message{{Role: "user", Content: "next"}}
	_ = hook(context.Background(), 0, nil, &again)
	if strings.Contains(again[0].Content, "Runtime Note") {
		t.Fatal("reminder repeated right after it was given")
	}

	readOnly := preparedRuntimeRun{memories: store, audience: audience.Owner(), memoriesReadOnly: true}
	readOnly.countMemoryTurn(&agent.Final{Output: "ok"}, nil)
	if n, _ := store.CountTurn(context.Background(), audience.Owner()); n != 1 {
		t.Fatalf("owner turns = %d after a read-only run, want only this count", n)
	}
}

func TestPrepareRunAddsTheMemoriesBlock(t *testing.T) {
	root := t.TempDir()
	deps := lifecycleTaskRuntimeDeps(func(llmutil.ResolvedRoute) (llm.Client, error) {
		return &lifecycleTaskRuntimeClient{}, nil
	})
	deps.RuntimePaths = runtimepaths.Paths{StateDir: root, JournalDir: filepath.Join(root, "journal"), MemoryDBPath: filepath.Join(root, "memory.db")}
	store, err := memories.Open(context.Background(), deps.RuntimePaths.MemoryDBPath)
	if err != nil {
		t.Fatalf("memories.Open() error = %v", err)
	}
	if _, err := store.Save(context.Background(), audience.Owner(), memories.Draft{
		Subject: "owner", Name: "release-notes", Type: memories.TypeFeedback, Description: "Release notes by DM", Body: "DM release notes to the owner.",
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	_ = store.Close()
	var prompt string
	deps.PromptAugment = func(spec *agent.PromptSpec, _ *tools.Registry) {
		for _, block := range spec.Blocks {
			prompt += block.Content + "\n"
		}
	}
	rt, err := NewRunPreparer(deps, BootstrapOptions{})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	defer func() { _ = rt.Close() }()
	cfg := toolsutil.RuntimeToolsRegisterConfig{Memories: toolsutil.MemoriesConfig{Enabled: true}}
	prepared, err := rt.PrepareEngine(audience.NewContext(context.Background(), audience.Owner()), RunRequest{Task: "ping", RuntimeToolsConfig: &cfg})
	if err != nil {
		t.Fatalf("PrepareEngine() error = %v", err)
	}
	defer func() { _ = prepared.Cleanup() }()
	if !strings.Contains(prompt, "[[ Memories ]]") || !strings.Contains(prompt, "DM release notes to the owner.") {
		t.Fatalf("prompt blocks = %q, want the memories block with the owner's memory", prompt)
	}
}

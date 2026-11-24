package configtools

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/cmd/mistermorph/configcmd"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

// scriptedClient answers each request with the next result, then ends the run.
type scriptedClient struct {
	mu       sync.Mutex
	results  []llm.Result
	requests []llm.Request
}

func (c *scriptedClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, req)
	if len(c.results) == 0 {
		return llm.Result{Text: `{"type":"final","output":"done"}`}, nil
	}
	next := c.results[0]
	c.results = c.results[1:]
	return next, nil
}

// lastToolResult is the last tool message the model was sent.
func (c *scriptedClient) lastToolResult() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.requests) - 1; i >= 0; i-- {
		msgs := c.requests[i].Messages
		for j := len(msgs) - 1; j >= 0; j-- {
			if msgs[j].Role == "tool" {
				return msgs[j].Content
			}
		}
	}
	return ""
}

func setCall(id string, params map[string]any) llm.Result {
	return llm.Result{ToolCalls: []llm.ToolCall{{ID: id, Name: SetToolName, Arguments: params}}}
}

// approvalsOnlyGuard is the guard every runtime has with guard.enabled off: it evaluates nothing,
// but keeps approval requests, so forced-approval tools can ask.
func approvalsOnlyGuard(t *testing.T) *guard.Guard {
	t.Helper()
	g, err := guard.NewChecked(guard.Snapshot{Enabled: false, Dir: filepath.Join(t.TempDir(), "guard")}, nil)
	if err != nil {
		t.Fatalf("guard.NewChecked() error = %v", err)
	}
	t.Cleanup(func() { _ = g.Close() })
	return g
}

func newEngine(client llm.Client, configPath string, store *memoryStore, g *guard.Guard) *agent.Engine {
	reg := tools.NewRegistry()
	opts := Options{ConfigPath: configPath}
	if store != nil {
		opts.SecretStore = store
	}
	_ = reg.Register(NewGetTool(opts))
	_ = reg.Register(NewSetTool(opts))
	engineOpts := []agent.Option{}
	if g != nil {
		engineOpts = append(engineOpts, agent.WithGuard(g))
	}
	return agent.New(client, reg, agent.Config{MaxSteps: 6}, agent.DefaultPromptSpec(), engineOpts...)
}

func pendingID(t *testing.T, final *agent.Final) string {
	t.Helper()
	if final == nil {
		t.Fatal("no final")
	}
	var id string
	switch out := final.Output.(type) {
	case agent.PendingOutput:
		id = out.ApprovalRequestID
	case *agent.PendingOutput:
		id = out.ApprovalRequestID
	}
	if id == "" {
		t.Fatalf("final = %#v, want a pending approval", final.Output)
	}
	return id
}

func ownerRunCtx() context.Context {
	return audience.NewContext(context.Background(), audience.Owner())
}

// Every config_set asks, even with the guard off; approving applies the call, as the agent.
func TestEngineAsksBeforeEveryChange(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt-old\n")
	g := approvalsOnlyGuard(t)
	client := &scriptedClient{results: []llm.Result{
		setCall("c1", map[string]any{"path": "llm.model", "value": "gpt-new"}),
		setCall("c2", map[string]any{"path": "max_steps", "value": "9"}),
	}}
	engine := newEngine(client, path, nil, g)
	ctx := ownerRunCtx()

	final, _, err := engine.Run(ctx, "use gpt-new", agent.RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	first := pendingID(t, final)
	rec, ok, err := g.GetApproval(ctx, first)
	if err != nil || !ok {
		t.Fatalf("GetApproval() = %v, %v", ok, err)
	}
	if !strings.Contains(rec.ActionSummaryRedacted, "llm.model") || !strings.Contains(rec.ActionSummaryRedacted, "gpt-old") || !strings.Contains(rec.ActionSummaryRedacted, "gpt-new") {
		t.Fatalf("approval summary = %q", rec.ActionSummaryRedacted)
	}
	pending, ok := agent.PendingApprovalToolFromResumeState(rec.ResumeState)
	if !ok || pending.Display["current_value"] != "gpt-old" || pending.Display["new_value"] != "gpt-new" {
		t.Fatalf("approval card = %+v", pending.Display)
	}
	if !strings.Contains(readConfig(t, path), "gpt-old") {
		t.Fatal("config changed before the approval")
	}

	if err := g.ResolveApproval(ctx, first, guard.ApprovalApproved, "owner", ""); err != nil {
		t.Fatal(err)
	}
	final, _, err = engine.Resume(ctx, first)
	if err != nil {
		t.Fatalf("Resume() error = %v", err)
	}
	if !strings.Contains(readConfig(t, path), "gpt-new") {
		t.Fatalf("config after approval = %q", readConfig(t, path))
	}
	if result := client.lastToolResult(); !strings.Contains(result, `"apply_mode": "next_generation"`) {
		t.Fatalf("tool result = %s", result)
	}
	// The next change asks again.
	second := pendingID(t, final)
	if second == first {
		t.Fatal("the second change reused the first approval")
	}
	if strings.Contains(readConfig(t, path), "max_steps") {
		t.Fatal("the second change ran without its own approval")
	}
}

func TestEngineDeniedApprovalChangesNothing(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt-old\n")
	store := newMemoryStore()
	g := approvalsOnlyGuard(t)
	client := &scriptedClient{results: []llm.Result{setCall("c1", map[string]any{"path": "llm.api_key", "value": "sk-denied-secret-value-0001"})}}
	engine := newEngine(client, path, store, g)
	ctx := ownerRunCtx()
	final, _, err := engine.Run(ctx, "set my key", agent.RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	id := pendingID(t, final)
	rec, _, _ := g.GetApproval(ctx, id)
	mustNotContain(t, "approval summary", rec.ActionSummaryRedacted, "sk-denied-secret-value-0001")
	pending, _ := agent.PendingApprovalToolFromResumeState(rec.ResumeState)
	if value, _ := pending.Display["new_value"].(string); !strings.HasPrefix(value, Mask) {
		t.Fatalf("approval card new_value = %#v, want masked", pending.Display["new_value"])
	}
	if err := g.ResolveApproval(ctx, id, guard.ApprovalDenied, "owner", ""); err != nil {
		t.Fatal(err)
	}
	// Resuming a denied approval does not run the call (runtimes cancel the task instead).
	if final, _, err := engine.Resume(ctx, id); err == nil {
		if out, ok := final.Output.(agent.PendingOutput); !ok || !strings.Contains(out.Message, "denied") {
			t.Fatalf("Resume() of a denied approval = %#v", final.Output)
		}
	}
	if config := readConfig(t, path); config != "llm:\n  model: gpt-old\n" || len(store.values()) != 0 {
		t.Fatalf("a denied change wrote: config %q, keyring %v", config, store.values())
	}
}

// Refused calls are refused before anyone is asked: no approval request exists.
func TestEngineRefusesBeforeAsking(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt\n")
	for name, tc := range map[string]struct {
		ctx    context.Context
		params map[string]any
	}{
		"denied path":   {ownerRunCtx(), map[string]any{"path": "guard.enabled", "value": "false"}},
		"mask":          {ownerRunCtx(), map[string]any{"path": "llm.api_key", "value": Mask}},
		"bad value":     {ownerRunCtx(), map[string]any{"path": "max_steps", "value": "many"}},
		"contact":       {audience.NewContext(context.Background(), audience.Contact("tg:7")), map[string]any{"path": "llm.model", "value": "x"}},
		"group":         {audience.NewContext(context.Background(), audience.Conversation("tg:-1")), map[string]any{"path": "llm.model", "value": "x"}},
		"unknown asker": {context.Background(), map[string]any{"path": "llm.model", "value": "x"}},
	} {
		t.Run(name, func(t *testing.T) {
			g := approvalsOnlyGuard(t)
			client := &scriptedClient{results: []llm.Result{setCall("c1", tc.params)}}
			final, _, err := newEngine(client, path, newMemoryStore(), g).Run(tc.ctx, "change it", agent.RunOptions{})
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if final == nil || final.Output != "done" {
				t.Fatalf("final = %#v, want the run to go on without an approval", final)
			}
			if result := client.lastToolResult(); !strings.Contains(result, "Error") {
				t.Fatalf("tool result = %q, want the refusal", result)
			}
		})
	}
	if readConfig(t, path) != "llm:\n  model: gpt\n" {
		t.Fatalf("config = %q", readConfig(t, path))
	}
}

// Without any approval store, config_set is denied: it never runs unasked.
func TestEngineWithoutApprovalsDenies(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: gpt\n")
	client := &scriptedClient{results: []llm.Result{setCall("c1", map[string]any{"path": "llm.model", "value": "x"})}}
	final, _, err := newEngine(client, path, nil, nil).Run(ownerRunCtx(), "change it", agent.RunOptions{})
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Run() = %#v, %v", final, err)
	}
	if readConfig(t, path) != "llm:\n  model: gpt\n" {
		t.Fatalf("config = %q", readConfig(t, path))
	}
}

// A change shows in `morph config get` as written: a stored secret as its keyring reference.
func TestChangeShowsInMorphConfigGet(t *testing.T) {
	path := dbConfig(t, "")
	store := newMemoryStore()
	if _, err := runSet(t, setTool(path, store), ownerCtx(), map[string]any{"path": "tools.bash.timeout", "value": "75s"}); err != nil {
		t.Fatal(err)
	}
	if _, err := runSet(t, setTool(path, store), ownerCtx(), map[string]any{"path": "slack.bot_token", "value": "xoxb-config-get-secret-01"}); err != nil {
		t.Fatal(err)
	}
	previous := viper.GetString("config")
	viper.Set("config", path)
	t.Cleanup(func() { viper.Set("config", previous) })
	for key, want := range map[string]string{"tools.bash.timeout": "75s\n", "slack.bot_token": "${secret:"} {
		cmd := configcmd.New()
		var out bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetArgs([]string{"get", key})
		if err := cmd.Execute(); err != nil {
			t.Fatalf("morph config get %s: %v", key, err)
		}
		if !strings.Contains(out.String(), want) {
			t.Fatalf("morph config get %s = %q, want %q", key, out.String(), want)
		}
	}
}

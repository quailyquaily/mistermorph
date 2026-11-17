package taskruntime

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

// fakeTelegram is the Telegram Bot API contacts_send delivers through. It records each
// sendMessage and, when failWith is set, rejects it as Telegram does.
type fakeTelegram struct {
	url      string
	mu       sync.Mutex
	sent     []map[string]any
	failWith string
}

func newFakeTelegram(t *testing.T) *fakeTelegram {
	t.Helper()
	fake := &fakeTelegram{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/sendMessage") {
			http.Error(w, "unexpected Telegram method "+r.URL.Path, http.StatusNotFound)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		fake.mu.Lock()
		failWith := fake.failWith
		if failWith == "" {
			fake.sent = append(fake.sent, body)
		}
		fake.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if failWith != "" {
			_, _ = w.Write([]byte(`{"ok":false,"description":"` + failWith + `"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":1}}`))
	}))
	t.Cleanup(server.Close)
	fake.url = server.URL
	return fake
}

func (f *fakeTelegram) messages() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.sent...)
}

// contactsSendSearchFixture is an ordinary runtime as Console, Telegram and Slack build it: a base
// registry without contacts_send, and RegisterTriggeredStaticTools over the same static config.
type contactsSendSearchFixture struct {
	stateDir string
	cfg      toolsutil.StaticRegistryConfig
	telegram *fakeTelegram
}

func newContactsSendSearchFixture(t *testing.T) *contactsSendSearchFixture {
	t.Helper()
	stateDir := t.TempDir()
	contactsDir := filepath.Join(stateDir, "contacts")
	telegram := newFakeTelegram(t)
	store := contacts.NewStoreInStateDir(stateDir, contactsDir)
	for _, contact := range []contacts.Contact{
		{ContactID: "tg:1001", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, ContactNickname: "Ann", TGUserID: 1001, TGPrivateChatID: 1001},
		{ContactID: "line_user:U0123456789abcdef0123456789abcdef", Kind: contacts.KindHuman, Channel: contacts.ChannelLine, ContactNickname: "Lin", LineUserID: "U0123456789abcdef0123456789abcdef"},
	} {
		if err := store.PutContact(context.Background(), contact); err != nil {
			t.Fatalf("PutContact(%s) error = %v", contact.ContactID, err)
		}
	}
	return &contactsSendSearchFixture{
		stateDir: stateDir,
		telegram: telegram,
		cfg: toolsutil.StaticRegistryConfig{
			ContactsSend: toolsutil.StaticContactsSendConfig{
				Enabled:          true,
				ContactsDir:      contactsDir,
				StateDir:         stateDir,
				TelegramBotToken: "test-token",
				TelegramBaseURL:  telegram.url,
				FailureCooldown:  time.Hour,
			},
		},
	}
}

type contactsSendSearchRun struct {
	client *scriptedClient
	err    error
}

// run runs one ordinary task whose model answers with results, through the same preparation every
// ordinary runtime uses.
func (f *contactsSendSearchFixture) run(t *testing.T, ctx context.Context, toolSearch bool, results ...llm.Result) contactsSendSearchRun {
	t.Helper()
	cfg := f.cfg
	client := &scriptedClient{results: results}
	route := llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "gpt-5.2"}}
	rt, err := Bootstrap(depsutil.CommonDependencies{
		Logger:          func() (*slog.Logger, error) { return slog.New(slog.NewTextHandler(io.Discard, nil)), nil },
		LogOptions:      func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) { return route, nil },
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil },
		Registry: func() *tools.Registry {
			reg := tools.NewRegistry()
			toolsutil.RegisterStaticTools(reg, cfg, nil, nil)
			return reg
		},
		RegisterTriggeredStaticTools: func(reg *tools.Registry, triggers map[string]bool) {
			toolsutil.RegisterStaticTools(reg, cfg, nil, triggers)
		},
		RuntimeToolsConfig: toolsutil.RuntimeToolsRegisterConfig{
			ToolSearch: toolsutil.ToolSearchConfig{Enabled: toolSearch},
		},
		RuntimePaths: runtimepaths.Paths{CheckpointRoot: f.stateDir, StateDir: f.stateDir},
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
	}, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 6}})
	if err != nil {
		t.Fatalf("Bootstrap() error = %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	_, err = rt.Run(ctx, RunRequest{Task: "tell Ann the build is green"})
	return contactsSendSearchRun{client: client, err: err}
}

func toolCall(id, name string, args map[string]any) llm.Result {
	return llm.Result{ToolCalls: []llm.ToolCall{{ID: id, Name: name, Arguments: args}}}
}

// toolResult is what the model was told about call id, read from the requests after it.
func (r contactsSendSearchRun) toolResult(t *testing.T, id string) string {
	t.Helper()
	for _, req := range r.client.requests {
		for _, msg := range req.Messages {
			if msg.ToolCallID == id {
				return msg.Content
			}
		}
	}
	t.Fatalf("no result for tool call %s in %d requests", id, len(r.client.requests))
	return ""
}

func hasRequestTool(req llm.Request, name string) bool {
	for _, tool := range req.Tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}

func searchFoundTool(t *testing.T, result, name string) bool {
	t.Helper()
	var out struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal([]byte(result), &out); err != nil {
		t.Fatalf("tool_search result %q: %v", result, err)
	}
	for _, tool := range out.Tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}

func TestOrdinaryRunFindsContactsSendWithToolSearchAndDelivers(t *testing.T) {
	for _, query := range []string{"contacts send", "contacts_send"} {
		t.Run(query, func(t *testing.T) {
			f := newContactsSendSearchFixture(t)
			run := f.run(t, context.Background(), true,
				toolCall("search", "tool_search", map[string]any{"query": query}),
				toolCall("send", "contacts_send", map[string]any{"contact_id": "tg:1001", "message_text": "The build is green."}),
			)
			if run.err != nil {
				t.Fatalf("Run() error = %v", run.err)
			}
			first := run.client.requests[0]
			if hasRequestTool(first, "contacts_send") || !hasRequestTool(first, "tool_search") {
				t.Fatalf("first request tools = %s, want tool_search and no contacts_send", requestTools(first))
			}
			if !hasRequestTool(first, "contacts_list") {
				t.Fatalf("first request tools = %s, want contacts_list visible as before", requestTools(first))
			}
			if strings.Contains(first.Messages[0].Content, "contacts_send") {
				t.Fatal("the system prompt names contacts_send before it is found")
			}
			if !searchFoundTool(t, run.toolResult(t, "search"), "contacts_send") {
				t.Fatalf("tool_search %q did not find contacts_send: %s", query, run.toolResult(t, "search"))
			}
			if !hasRequestTool(run.client.requests[1], "contacts_send") {
				t.Fatalf("after search tools = %s, want contacts_send", requestTools(run.client.requests[1]))
			}
			result := run.toolResult(t, "send")
			if !strings.Contains(result, `"accepted": true`) {
				t.Fatalf("contacts_send result = %s, want an accepted outcome", result)
			}
			sent := f.telegram.messages()
			if len(sent) != 1 || sent[0]["chat_id"] != float64(1001) || !strings.Contains(sent[0]["text"].(string), "The build is green.") {
				t.Fatalf("Telegram sendMessage calls = %#v, want one to chat 1001", sent)
			}
		})
	}
}

func TestOrdinaryRunHidesContactsSendUntilFound(t *testing.T) {
	f := newContactsSendSearchFixture(t)
	run := f.run(t, context.Background(), true,
		toolCall("early", "contacts_send", map[string]any{"contact_id": "tg:1001", "message_text": "too early"}),
	)
	if run.err != nil {
		t.Fatalf("Run() error = %v", run.err)
	}
	if result := run.toolResult(t, "early"); !strings.Contains(result, "is not available") {
		t.Fatalf("contacts_send before tool_search = %s, want not available", result)
	}
	if sent := f.telegram.messages(); len(sent) != 0 {
		t.Fatalf("an unfound contacts_send delivered %#v", sent)
	}
}

func TestOrdinaryRunWithoutToolSearchHasNoContactsSend(t *testing.T) {
	f := newContactsSendSearchFixture(t)
	run := f.run(t, context.Background(), false,
		toolCall("send", "contacts_send", map[string]any{"contact_id": "tg:1001", "message_text": "hi"}),
	)
	if run.err != nil {
		t.Fatalf("Run() error = %v", run.err)
	}
	for i, req := range run.client.requests {
		if hasRequestTool(req, "contacts_send") || hasRequestTool(req, "tool_search") {
			t.Fatalf("request %d tools = %s, want neither contacts_send nor tool_search", i, requestTools(req))
		}
	}
	if result := run.toolResult(t, "send"); !strings.Contains(result, "not found") {
		t.Fatalf("contacts_send without tool search = %s, want not found", result)
	}
	if sent := f.telegram.messages(); len(sent) != 0 {
		t.Fatalf("contacts_send without tool search delivered %#v", sent)
	}
}

func TestOrdinaryRunDisabledContactsSendIsNotFound(t *testing.T) {
	f := newContactsSendSearchFixture(t)
	f.cfg.ContactsSend.Enabled = false
	run := f.run(t, context.Background(), true,
		toolCall("search", "tool_search", map[string]any{"query": "contacts_send"}),
		toolCall("send", "contacts_send", map[string]any{"contact_id": "tg:1001", "message_text": "hi"}),
	)
	if run.err != nil {
		t.Fatalf("Run() error = %v", run.err)
	}
	// With nothing else to hide, the run offers no tool_search at all; either way nothing finds
	// a disabled contacts_send.
	if search := run.toolResult(t, "search"); strings.HasPrefix(strings.TrimSpace(search), "{") && searchFoundTool(t, search, "contacts_send") {
		t.Fatal("tool_search found a disabled contacts_send")
	}
	for i, req := range run.client.requests {
		if hasRequestTool(req, "contacts_send") {
			t.Fatalf("request %d tools = %s, want no disabled contacts_send", i, requestTools(req))
		}
	}
	if result := run.toolResult(t, "send"); !strings.Contains(result, "tool 'contacts_send' not found") {
		t.Fatalf("disabled contacts_send call = %s, want an unknown tool", result)
	}
	if sent := f.telegram.messages(); len(sent) != 0 {
		t.Fatalf("disabled contacts_send delivered %#v", sent)
	}
}

func TestOrdinaryRunExplicitContactsSendStaysVisible(t *testing.T) {
	f := newContactsSendSearchFixture(t)
	client := &scriptedClient{}
	route := llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "gpt-5.2"}}
	cfg := f.cfg
	rt, err := Bootstrap(depsutil.CommonDependencies{
		Logger:          func() (*slog.Logger, error) { return slog.New(slog.NewTextHandler(io.Discard, nil)), nil },
		LogOptions:      func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) { return route, nil },
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil },
		Registry:        func() *tools.Registry { return tools.NewRegistry() },
		ToolTriggers:    func(task string) map[string]bool { return toolsutil.BuiltinToolTriggers(task, nil) },
		RegisterTriggeredStaticTools: func(reg *tools.Registry, triggers map[string]bool) {
			toolsutil.RegisterStaticTools(reg, cfg, nil, triggers)
		},
		RuntimeToolsConfig: toolsutil.RuntimeToolsRegisterConfig{ToolSearch: toolsutil.ToolSearchConfig{Enabled: true}},
		RuntimePaths:       runtimepaths.Paths{CheckpointRoot: f.stateDir, StateDir: f.stateDir},
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
	}, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 2}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	if _, err := rt.Run(context.Background(), RunRequest{Task: "$contacts_send tell Ann"}); err != nil {
		t.Fatal(err)
	}
	if got := requestTools(client.requests[0]); !hasRequestTool(client.requests[0], "contacts_send") {
		t.Fatalf("explicit $contacts_send tools = %s, want contacts_send visible from the start", got)
	}
}

func TestOrdinaryRunKeepsAwarenessContactsSend(t *testing.T) {
	cfg := toolsutil.StaticRegistryConfig{ContactsSend: toolsutil.StaticContactsSendConfig{Enabled: true, ContactsDir: t.TempDir()}}
	cfg.Common.Awareness = true
	reg := tools.NewRegistry()
	toolsutil.RegisterStaticTools(reg, cfg, nil, nil)
	triggers := map[string]bool{toolsutil.BuiltinAgentSend: true}
	if got := searchableStaticToolTriggers(reg, triggers, toolsutil.ToolSearchConfig{Enabled: true}); got[toolsutil.SearchableContactsSendTrigger] {
		t.Fatal("a registry that already has contacts_send asked for the searchable one")
	}
	got := searchableStaticToolTriggers(tools.NewRegistry(), triggers, toolsutil.ToolSearchConfig{Enabled: true})
	if !got[toolsutil.SearchableContactsSendTrigger] || !got[toolsutil.BuiltinAgentSend] {
		t.Fatalf("ordinary run triggers = %v, want agent_send and the searchable contacts_send", got)
	}
	if triggers[toolsutil.SearchableContactsSendTrigger] {
		t.Fatal("the run's own triggers were changed")
	}
	if got := searchableStaticToolTriggers(tools.NewRegistry(), triggers, toolsutil.ToolSearchConfig{}); got[toolsutil.SearchableContactsSendTrigger] {
		t.Fatal("tool search off asked for the searchable contacts_send")
	}
}

func TestFoundContactsSendKeepsSafeguards(t *testing.T) {
	found := func(id string, args map[string]any) []llm.Result {
		return []llm.Result{
			toolCall("search", "tool_search", map[string]any{"query": "contacts send"}),
			toolCall(id, "contacts_send", args),
		}
	}
	tests := []struct {
		name string
		ctx  func() context.Context
		fail string
		args map[string]any
		want []string
	}{
		{
			name: "current conversation counterpart is blocked",
			ctx: func() context.Context {
				return builtin.WithContactsSendRuntimeContext(context.Background(), builtin.ContactsSendRuntimeContext{ForbiddenTargetIDs: []string{"tg:1001"}})
			},
			args: map[string]any{"contact_id": "tg:1001", "message_text": "hi"},
			want: []string{"contacts_send blocked", "tg:1001"},
		},
		{
			name: "unknown contact",
			args: map[string]any{"contact_id": "tg:@nobody", "message_text": "hi"},
			want: []string{"contact not found"},
		},
		{
			name: "missing contact_id",
			args: map[string]any{"message_text": "hi"},
			want: []string{"missing required param: contact_id"},
		},
		{
			name: "chat_id that is not the contact's",
			args: map[string]any{"contact_id": "tg:1001", "chat_id": "line:C0123456789abcdef0123456789abcdef", "message_text": "hi"},
			want: []string{"chat_id must be empty or match contact_id"},
		},
		{
			name: "route without credentials",
			args: map[string]any{"contact_id": "line_user:U0123456789abcdef0123456789abcdef", "message_text": "hi"},
			want: []string{`"accepted": false`, `"error"`},
		},
		{
			name: "channel rejects the delivery",
			fail: "Forbidden: bot was blocked by the user",
			args: map[string]any{"contact_id": "tg:1001", "message_text": "hi"},
			want: []string{`"accepted": false`, "bot was blocked by the user"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newContactsSendSearchFixture(t)
			f.telegram.failWith = tc.fail
			ctx := context.Background()
			if tc.ctx != nil {
				ctx = tc.ctx()
			}
			run := f.run(t, ctx, true, found("send", tc.args)...)
			if run.err != nil {
				t.Fatalf("Run() error = %v", run.err)
			}
			if !hasRequestTool(run.client.requests[1], "contacts_send") {
				t.Fatalf("contacts_send was not found: %s", requestTools(run.client.requests[1]))
			}
			result := run.toolResult(t, "send")
			for _, want := range tc.want {
				if !strings.Contains(result, want) {
					t.Fatalf("contacts_send result = %s, want %q", result, want)
				}
			}
			if strings.Contains(result, `"accepted": true`) {
				t.Fatalf("contacts_send result = %s, claims delivery", result)
			}
			if sent := f.telegram.messages(); len(sent) != 0 {
				t.Fatalf("Telegram delivered %#v", sent)
			}
		})
	}
}

package runtimetest

import (
	"context"
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
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// ChannelRun runs text as one inbound message through a channel's own task function on rt, in a
// group chat when group is true and in a direct chat otherwise. The sender is never the contact
// tg:1001 ("Ann") the model tries to message.
type ChannelRun func(t testing.TB, rt *taskruntime.Runtime, text string, group bool) error

// CheckContactsSendOptIn checks that run keeps a group chat's contacts_send opt-in with tool search
// on: in a group chat, contacts_send can be neither seen, found nor called unless the message names
// $contacts_send, while a direct chat still finds it with tool_search. Each case's model goes as far
// as it can toward sending to Ann: it searches for contacts_send when it does not see it and then
// calls it anyway. Messages are delivered to a fake Telegram Bot API; nothing leaves the machine.
func CheckContactsSendOptIn(t *testing.T, run ChannelRun) {
	t.Helper()
	t.Run("group chat without $contacts_send", func(t *testing.T) {
		got := attemptContactsSend(t, run, "tell Ann the build is green", true)
		for i, req := range got.requests {
			if hasTool(req, "contacts_send") {
				t.Fatalf("request %d offers contacts_send in a group chat without $contacts_send", i)
			}
		}
		if got.searchResult != "" && foundTool(got.searchResult, "contacts_send") {
			t.Fatalf("tool_search found contacts_send in a group chat: %s", got.searchResult)
		}
		if !strings.Contains(got.sendResult, "tool 'contacts_send' not found") {
			t.Fatalf("contacts_send call in a group chat = %q, want an unknown tool", got.sendResult)
		}
		if len(got.delivered) != 0 {
			t.Fatalf("a group chat without $contacts_send delivered %v", got.delivered)
		}
	})
	t.Run("group chat with $contacts_send", func(t *testing.T) {
		got := attemptContactsSend(t, run, "$contacts_send tell Ann the build is green", true)
		if len(got.requests) == 0 || !hasTool(got.requests[0], "contacts_send") {
			t.Fatal("$contacts_send in a group chat did not offer contacts_send from the start")
		}
		if !got.deliveredToAnn() {
			t.Fatalf("$contacts_send in a group chat: result %q, delivered %v; want one delivery", got.sendResult, got.delivered)
		}
	})
	t.Run("direct chat", func(t *testing.T) {
		got := attemptContactsSend(t, run, "tell Ann the build is green", false)
		if len(got.requests) == 0 || hasTool(got.requests[0], "contacts_send") || !hasTool(got.requests[0], "tool_search") {
			t.Fatal("a direct chat's first request should offer tool_search and not contacts_send")
		}
		if !foundTool(got.searchResult, "contacts_send") {
			t.Fatalf("tool_search in a direct chat did not find contacts_send: %s", got.searchResult)
		}
		if !got.deliveredToAnn() {
			t.Fatalf("found contacts_send in a direct chat: result %q, delivered %v; want one delivery", got.sendResult, got.delivered)
		}
	})
}

type contactsSendAttempt struct {
	requests     []llm.Request
	searchResult string
	sendResult   string
	delivered    []string
}

func attemptContactsSend(t *testing.T, run ChannelRun, text string, group bool) contactsSendAttempt {
	t.Helper()
	stateDir := t.TempDir()
	contactsDir := filepath.Join(stateDir, "contacts")
	store := contacts.NewStoreInStateDir(stateDir, contactsDir)
	ann := contacts.Contact{ContactID: "tg:1001", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, ContactNickname: "Ann", TGUserID: 1001, TGPrivateChatID: 1001}
	if err := store.PutContact(context.Background(), ann); err != nil {
		t.Fatalf("PutContact() error = %v", err)
	}

	var mu sync.Mutex
	var delivered []string
	telegram := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		delivered = append(delivered, r.URL.Path+" "+string(raw))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":1}}`))
	}))
	defer telegram.Close()

	// The runtime's static tools as BuildGenerationDependencies wires them, with contacts_send
	// enabled and delivering to the fake Bot API.
	cfg := toolsutil.StaticRegistryConfig{ContactsSend: toolsutil.StaticContactsSendConfig{
		Enabled:          true,
		ContactsDir:      contactsDir,
		StateDir:         stateDir,
		TelegramBotToken: "test-token",
		TelegramBaseURL:  telegram.URL,
		FailureCooldown:  time.Hour,
	}}
	base := tools.NewRegistry()
	toolsutil.RegisterStaticTools(base, cfg, nil, nil)
	client := &optInClient{}
	route := llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "gpt-5.2"}}
	rt, err := taskruntime.Bootstrap(depsutil.CommonDependencies{
		Logger:          func() (*slog.Logger, error) { return slog.New(slog.NewTextHandler(io.Discard, nil)), nil },
		LogOptions:      func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) { return route, nil },
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil },
		Registry:        func() *tools.Registry { return base },
		ToolTriggers:    func(task string) map[string]bool { return toolsutil.BuiltinToolTriggers(task, nil) },
		RegisterTriggeredStaticTools: func(reg *tools.Registry, triggers map[string]bool) {
			toolsutil.RegisterStaticTools(reg, cfg, nil, triggers)
		},
		RuntimeToolsConfig: toolsutil.RuntimeToolsRegisterConfig{ToolSearch: toolsutil.ToolSearchConfig{Enabled: true}},
		RuntimePaths:       runtimepaths.Paths{CheckpointRoot: stateDir, StateDir: stateDir, ContactsDir: contactsDir},
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
	}, taskruntime.BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 4}})
	if err != nil {
		t.Fatalf("taskruntime.Bootstrap() error = %v", err)
	}
	defer func() { _ = rt.Close() }()
	if _, ok := base.Get(toolsutil.BuiltinContactsSend); ok {
		t.Fatal("the base registry has contacts_send")
	}
	if err := run(t, rt, text, group); err != nil {
		t.Fatalf("channel run error = %v", err)
	}

	client.mu.Lock()
	defer client.mu.Unlock()
	out := contactsSendAttempt{requests: append([]llm.Request(nil), client.requests...)}
	for _, req := range client.requests {
		for _, msg := range req.Messages {
			switch msg.ToolCallID {
			case "search":
				out.searchResult = msg.Content
			case "send":
				out.sendResult = msg.Content
			}
		}
	}
	if out.sendResult == "" {
		t.Fatalf("the model's contacts_send call got no result in %d requests", len(client.requests))
	}
	mu.Lock()
	out.delivered = append([]string(nil), delivered...)
	mu.Unlock()
	return out
}

// optInClient tries to message Ann: it calls contacts_send when it sees it, searches for it first
// when it does not but tool_search is offered, and calls it after the search either way.
type optInClient struct {
	mu       sync.Mutex
	requests []llm.Request
	searched bool
	sent     bool
}

func (c *optInClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, req)
	switch {
	case c.sent:
		return llm.Result{Text: `{"type":"final","output":"done"}`}, nil
	case !c.searched && !hasTool(req, "contacts_send") && hasTool(req, "tool_search"):
		c.searched = true
		return llm.Result{ToolCalls: []llm.ToolCall{{ID: "search", Name: "tool_search", Arguments: map[string]any{"query": "contacts_send"}}}}, nil
	default:
		c.sent = true
		return llm.Result{ToolCalls: []llm.ToolCall{{ID: "send", Name: "contacts_send", Arguments: map[string]any{"contact_id": "tg:1001", "message_text": "The build is green."}}}}, nil
	}
}

// deliveredToAnn: contacts_send reported a delivery and the Bot API got exactly one message, to
// Ann's private chat.
func (a contactsSendAttempt) deliveredToAnn() bool {
	return strings.Contains(a.sendResult, `"accepted": true`) && len(a.delivered) == 1 &&
		strings.HasSuffix(strings.SplitN(a.delivered[0], " ", 2)[0], "/sendMessage") &&
		strings.Contains(a.delivered[0], `"chat_id":1001`) && strings.Contains(a.delivered[0], "The build is green.")
}

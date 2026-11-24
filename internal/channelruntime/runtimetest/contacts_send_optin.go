package runtimetest

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/livesend"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
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

// PublicThreadRun answers text as one public post that mentions the account, through a social
// network's runtime started with deps, and returns once the task has finished. The post's author is
// never Ann (tg:1001).
type PublicThreadRun func(t testing.TB, deps depsutil.CommonDependencies, text string) error

// CheckPublicThreadContactsSendOptIn checks that run keeps a public thread's contacts_send opt-in
// with tool search on: without $contacts_send, contacts_send can be neither seen, found nor called;
// with it, the task can message Ann but still not send the post's author, authorContactID, a text
// message (a public reply is the only answer to the author); a file to the author gets past that
// block. Messages go to a fake Telegram Bot API.
func CheckPublicThreadContactsSendOptIn(t *testing.T, run PublicThreadRun, authorContactID string) {
	t.Helper()
	channelRun := func(t testing.TB, deps depsutil.CommonDependencies, text string) error { return run(t, deps, text) }
	t.Run("public post without $contacts_send", func(t *testing.T) {
		got := attemptWithDeps(t, channelRun, "tell Ann the build is green", annContactID)
		for i, req := range got.requests {
			if hasTool(req, "contacts_send") {
				t.Fatalf("request %d offers contacts_send in a public thread without $contacts_send", i)
			}
		}
		if got.searchResult != "" && foundTool(got.searchResult, "contacts_send") {
			t.Fatalf("tool_search found contacts_send in a public thread: %s", got.searchResult)
		}
		if !strings.Contains(got.sendResult, "tool 'contacts_send' not found") {
			t.Fatalf("contacts_send call in a public thread = %q, want an unknown tool", got.sendResult)
		}
		if len(got.delivered) != 0 {
			t.Fatalf("a public thread without $contacts_send delivered %v", got.delivered)
		}
	})
	t.Run("public post with $contacts_send", func(t *testing.T) {
		got := attemptWithDeps(t, channelRun, "$contacts_send tell Ann the build is green", annContactID)
		if len(got.requests) == 0 || !hasTool(got.requests[0], "contacts_send") {
			t.Fatal("$contacts_send in a public thread did not offer contacts_send from the start")
		}
		if !got.deliveredToAnn() {
			t.Fatalf("$contacts_send in a public thread: result %q, delivered %v; want one delivery", got.sendResult, got.delivered)
		}
	})
	t.Run("public post with $contacts_send to its author", func(t *testing.T) {
		got := attemptWithDeps(t, channelRun, "$contacts_send message me privately", authorContactID)
		if !strings.Contains(got.sendResult, "contacts_send blocked") || !strings.Contains(got.sendResult, "current conversation counterpart") || !strings.Contains(got.sendResult, "pass path to send them a file") {
			t.Fatalf("contacts_send to the post's author = %q, want blocked", got.sendResult)
		}
		if len(got.delivered) != 0 {
			t.Fatalf("contacts_send to the post's author delivered %v", got.delivered)
		}
	})
	// A file is not blocked: it goes to the author's own route, the network's direct messages.
	// Bluesky and X direct messages cannot carry files, and no such runtime runs in the test, so
	// the send fails there, past the current-conversation block.
	t.Run("public post with $contacts_send sends its author a file", func(t *testing.T) {
		author, channel := publicThreadAuthor(t, authorContactID)
		got := attemptSend(t, channelRun, "$contacts_send send me the report", sendCall{to: authorContactID, file: true, contacts: []contacts.Contact{author}})
		if strings.Contains(got.sendResult, "blocked") {
			t.Fatalf("a file to the post's author = %q, want it past the current-conversation block", got.sendResult)
		}
		if want := channel + ": " + livesend.ErrNotRunning.Error(); !strings.Contains(got.sendResult, want) {
			t.Fatalf("a file to the post's author = %q, want the author's %s route to be tried (%q)", got.sendResult, channel, want)
		}
		if len(got.delivered) != 0 {
			t.Fatalf("a file to the post's author went to Telegram: %v", got.delivered)
		}
	})
}

// publicThreadAuthor is the contact of a Bluesky or X post's author, authorContactID, and its
// channel.
func publicThreadAuthor(t *testing.T, authorContactID string) (contacts.Contact, string) {
	t.Helper()
	contact := contacts.Contact{ContactID: authorContactID, Kind: contacts.KindHuman, ContactNickname: "Stranger"}
	switch {
	case strings.HasPrefix(authorContactID, "bluesky_user:"):
		contact.Channel, contact.BlueskyUserID = contacts.ChannelBluesky, strings.TrimPrefix(authorContactID, "bluesky_user:")
	case strings.HasPrefix(authorContactID, "x_user:"):
		contact.Channel, contact.XUserID = contacts.ChannelX, strings.TrimPrefix(authorContactID, "x_user:")
	default:
		t.Fatalf("author %q is neither a Bluesky nor an X user", authorContactID)
	}
	return contact, contact.Channel
}

// annContactID is the contact the checks try to message.
const annContactID = "tg:1001"

type contactsSendAttempt struct {
	requests     []llm.Request
	searchResult string
	sendResult   string
	delivered    []string
}

func attemptContactsSend(t *testing.T, run ChannelRun, text string, group bool) contactsSendAttempt {
	t.Helper()
	return attemptContactsSendTo(t, run, text, group, annContactID)
}

// attemptContactsSendTo is attemptContactsSend with the model messaging contactID.
func attemptContactsSendTo(t *testing.T, run ChannelRun, text string, group bool, contactID string) contactsSendAttempt {
	t.Helper()
	return attemptWithDeps(t, func(t testing.TB, deps depsutil.CommonDependencies, text string) error {
		rt, err := taskruntime.Bootstrap(deps, taskruntime.BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 4}})
		if err != nil {
			t.Fatalf("taskruntime.Bootstrap() error = %v", err)
		}
		defer func() { _ = rt.Close() }()
		return run(t, rt, text, group)
	}, text, contactID)
}

// attemptWithDeps runs text through run with dependencies whose model messages contactID.
func attemptWithDeps(t *testing.T, run func(t testing.TB, deps depsutil.CommonDependencies, text string) error, text string, contactID string) contactsSendAttempt {
	t.Helper()
	return attemptSend(t, run, text, sendCall{to: contactID})
}

// sendCall is the contacts_send call the model makes: to the contact to, with a file from
// file_cache_dir when file is set (and a text message otherwise). contacts are added to Ann.
type sendCall struct {
	to       string
	file     bool
	contacts []contacts.Contact
}

// attemptSend runs text through run with dependencies whose model makes call.
func attemptSend(t *testing.T, run func(t testing.TB, deps depsutil.CommonDependencies, text string) error, text string, call sendCall) contactsSendAttempt {
	t.Helper()
	stateDir := t.TempDir()
	contactsDir := filepath.Join(stateDir, "contacts")
	cacheDir := t.TempDir() // file_cache_dir; never under the state dir, which is not sent from
	if err := os.WriteFile(filepath.Join(cacheDir, "report.txt"), []byte("the report"), 0o644); err != nil {
		t.Fatal(err)
	}
	store := contacts.NewStoreInStateDir(stateDir, contactsDir)
	ann := contacts.Contact{ContactID: annContactID, Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, ContactNickname: "Ann", TGUserID: 1001, TGPrivateChatID: 1001}
	for _, contact := range append([]contacts.Contact{ann}, call.contacts...) {
		if err := store.PutContact(context.Background(), contact); err != nil {
			t.Fatalf("PutContact(%s) error = %v", contact.ContactID, err)
		}
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
	cfg := toolsutil.StaticRegistryConfig{Common: toolsutil.StaticCommonConfig{PathRoots: pathroots.New("", cacheDir, stateDir)}, ContactsSend: toolsutil.StaticContactsSendConfig{
		Enabled:          true,
		ContactsDir:      contactsDir,
		StateDir:         stateDir,
		TelegramBotToken: "test-token",
		TelegramBaseURL:  telegram.URL,
		FailureCooldown:  time.Hour,
	}}
	base := tools.NewRegistry()
	toolsutil.RegisterStaticTools(base, cfg, nil, nil)
	client := &optInClient{to: call.to, file: call.file}
	route := llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "gpt-5.2"}}
	deps := depsutil.CommonDependencies{
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
		RuntimePaths: runtimepaths.Paths{
			CheckpointRoot: stateDir, StateDir: stateDir, ContactsDir: contactsDir,
			TasksDir: filepath.Join(stateDir, "tasks"), JournalDir: filepath.Join(stateDir, "journal"),
			WorkspaceAttachmentsPath: filepath.Join(stateDir, "workspace_attachments.json"),
		},
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
	}
	if _, ok := base.Get(toolsutil.BuiltinContactsSend); ok {
		t.Fatal("the base registry has contacts_send")
	}
	if err := run(t, deps, text); err != nil {
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

// optInClient tries to message to (Ann unless a check says otherwise), or to send it file_cache_dir's
// report.txt when file is set: it calls contacts_send when it sees it, searches for it first when
// it does not but tool_search is offered, and calls it after the search either way.
type optInClient struct {
	to       string
	file     bool
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
		args := map[string]any{"contact_id": c.to, "message_text": "The build is green."}
		if c.file {
			args = map[string]any{"contact_id": c.to, "path": "file_cache_dir/report.txt"}
		}
		return llm.Result{ToolCalls: []llm.ToolCall{{ID: "send", Name: "contacts_send", Arguments: args}}}, nil
	}
}

// deliveredToAnn: contacts_send reported a delivery and the Bot API got exactly one message, to
// Ann's private chat.
func (a contactsSendAttempt) deliveredToAnn() bool {
	return strings.Contains(a.sendResult, `"accepted": true`) && len(a.delivered) == 1 &&
		strings.HasSuffix(strings.SplitN(a.delivered[0], " ", 2)[0], "/sendMessage") &&
		strings.Contains(a.delivered[0], `"chat_id":1001`) && strings.Contains(a.delivered[0], "The build is green.")
}

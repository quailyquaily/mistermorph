package wechat

import (
	"context"
	"encoding/hex"
	"encoding/json"
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
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/wechatapi"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type stubLLM struct{}

func (stubLLM) Chat(context.Context, llm.Request) (llm.Result, error) {
	return llm.Result{Text: `{"type":"final","output":"hello back"}`}, nil
}

type mapReader map[string]string

func (m mapReader) GetString(key string) string { return m[key] }

func testDeps(t *testing.T) (accountdm.Dependencies, daemonruntime.TaskView) {
	t.Helper()
	paths := runtimepaths.FromReader(mapReader{"file_state_dir": t.TempDir(), "file_cache_dir": t.TempDir()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	deps := accountdm.Dependencies{CommonDependencies: depsutil.CommonDependencies{
		Logger:          func() (*slog.Logger, error) { return logger, nil },
		LogOptions:      func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) { return llmutil.ResolvedRoute{}, nil },
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return stubLLM{}, nil },
		Registry:        func() *tools.Registry { return tools.NewRegistry() },
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
		RuntimePaths: paths,
	}}
	store, err := daemonruntime.NewTaskViewForTarget("wechat", 10, daemonruntime.TaskViewConfig{TasksDir: paths.TasksDir, JournalDir: paths.JournalDir})
	if err != nil {
		t.Fatal(err)
	}
	return deps, store
}

// fakeILink serves one batch of updates (twice, as a replay), then a session-expired error.
type fakeILink struct {
	mu    sync.Mutex
	polls int
	sent  []map[string]any
}

func (f *fakeILink) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/ilink/bot/getupdates":
			f.polls++
			switch {
			case f.polls <= 2:
				_, _ = io.WriteString(w, `{"ret":0,"get_updates_buf":"c1","msgs":[
					{"message_id":11,"from_user_id":"o9u@im.wechat","message_type":1,"context_token":"ctx-1","item_list":[{"type":1,"text_item":{"text":"hi there"}}]},
					{"message_id":12,"from_user_id":"o9u@im.wechat","message_type":1,"context_token":"ctx-2","item_list":[{"type":1,"text_item":{"text":"/id"}}]},
					{"message_id":13,"from_user_id":"o9v@im.wechat","group_id":"g1","message_type":1,"item_list":[{"type":1,"text_item":{"text":"group chatter"}}]},
					{"message_id":14,"from_user_id":"bot@im.bot","message_type":2,"item_list":[{"type":1,"text_item":{"text":"echo"}}]}
				]}`)
			case f.polls < 6:
				_, _ = io.WriteString(w, `{"ret":0,"msgs":[]}`)
			default:
				_, _ = io.WriteString(w, `{"ret":-14,"errmsg":"session timeout"}`)
			}
		case "/ilink/bot/sendmessage":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.sent = append(f.sent, body["msg"].(map[string]any))
			_, _ = io.WriteString(w, `{"ret":0}`)
		case "/ilink/bot/getconfig":
			_, _ = io.WriteString(w, `{"ret":0,"typing_ticket":"tk"}`)
		default:
			_, _ = io.WriteString(w, `{"ret":0}`)
		}
	}
}

func (f *fakeILink) texts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, msg := range f.sent {
		items := msg["item_list"].([]any)
		text := items[0].(map[string]any)["text_item"].(map[string]any)["text"].(string)
		out = append(out, msg["to_user_id"].(string)+"|"+msg["context_token"].(string)+"|"+text)
	}
	return out
}

func TestRuntimeAnswersPrivateMessagesOnceAndStopsOnAnExpiredSession(t *testing.T) {
	fake := &fakeILink{}
	server := httptest.NewServer(fake.handler(t))
	defer server.Close()
	client, err := wechatapi.NewClient("tok", wechatapi.Options{BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	deps, store := testDeps(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transportReady := make(chan *transport, 1)
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, deps, RunOptions{BotToken: "tok", BotID: "bot@im.bot", Options: accountdm.Options{TaskStore: store}, client: client})
	}()
	_ = transportReady
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		texts := fake.texts()
		if len(texts) >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	texts := fake.texts()
	joined := strings.Join(texts, "\n")
	if strings.Count(joined, "hello back") != 1 || !strings.Contains(joined, "o9u@im.wechat|ctx-2|chat_id=wechat:o9u@im.wechat") {
		t.Fatalf("sent = %q", texts)
	}
	if strings.Contains(joined, "o9v@im.wechat") {
		t.Fatal("a group message was answered")
	}
	// The reply to the first message carries the newest context token the user sent.
	for _, text := range texts {
		if strings.HasSuffix(text, "hello back") && !strings.HasPrefix(text, "o9u@im.wechat|ctx-") {
			t.Fatalf("reply without context: %q", text)
		}
	}
	// A second process cannot poll the same bot.
	if err := Run(ctx, deps, RunOptions{BotToken: "tok", BotID: "bot@im.bot", client: client}); err == nil || !strings.Contains(err.Error(), "already polling") {
		t.Fatalf("second poller = %v", err)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run() = %v", err)
	}
}

func TestTransportReportsReauthOnAnExpiredSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ret":-14,"errmsg":"session timeout"}`)
	}))
	defer server.Close()
	client, _ := wechatapi.NewClient("tok", wechatapi.Options{BaseURL: server.URL, HTTPClient: server.Client()})
	tr := newTransport(client, "bot", slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tr.Run(ctx, func(context.Context, accountdm.Inbound) error { return nil }) }()
	deadline := time.Now().Add(5 * time.Second)
	for tr.Overview()["status"] != StatusReauth && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if tr.Overview()["status"] != StatusReauth {
		t.Fatalf("status = %v", tr.Overview()["status"])
	}
	cancel()
	<-done
}

// recordingLLM answers like stubLLM and keeps the user messages it was given.
type recordingLLM struct {
	mu   sync.Mutex
	seen []string
}

func (r *recordingLLM) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, msg := range req.Messages {
		if msg.Role == "user" {
			r.seen = append(r.seen, msg.Content)
		}
	}
	return llm.Result{Text: `{"type":"final","output":"nice picture"}`}, nil
}

func (r *recordingLLM) joined() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.seen, "\n")
}

func TestRuntimeSavesAnImageForTheAgent(t *testing.T) {
	key := []byte("0123456789abcdef")
	picture := []byte("\x89PNG\r\n\x1a\nfake image")
	encrypted, _ := wechatapi.EncryptECB(picture, key)
	var mu sync.Mutex
	polls, downloads := 0, 0
	var replies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/ilink/bot/getupdates":
			polls++
			if polls <= 2 {
				_, _ = io.WriteString(w, `{"ret":0,"msgs":[{"message_id":21,"from_user_id":"o9u@im.wechat","message_type":1,"context_token":"c",
					"item_list":[{"type":2,"image_item":{"aeskey":"`+hex.EncodeToString(key)+`","media":{"encrypt_query_param":"IMG"}}}]}]}`)
				return
			}
			_, _ = io.WriteString(w, `{"ret":0,"msgs":[]}`)
		case "/c2c/download":
			downloads++
			_, _ = w.Write(encrypted)
		case "/ilink/bot/sendmessage":
			var body struct {
				Msg Message `json:"msg"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			replies = append(replies, body.Msg.Text())
			_, _ = io.WriteString(w, `{"ret":0}`)
		default:
			_, _ = io.WriteString(w, `{"ret":0}`)
		}
	}))
	defer server.Close()
	client, err := wechatapi.NewClient("tok", wechatapi.Options{BaseURL: server.URL, CDNBaseURL: server.URL + "/c2c", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	deps, store := testDeps(t)
	model := &recordingLLM{}
	deps.CreateLLMClient = func(llmutil.ResolvedRoute) (llm.Client, error) { return model, nil }
	cacheDir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = Run(ctx, deps, RunOptions{BotToken: "tok", BotID: "bot@im.bot", Options: accountdm.Options{TaskStore: store, FileCacheDir: cacheDir}, client: client})
	}()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(replies)
		mu.Unlock()
		if n > 0 && polls > 4 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(replies) != 1 || replies[0] != "nice picture" || downloads != 1 {
		t.Fatalf("replies %q, downloads %d", replies, downloads)
	}
	prompt := model.joined()
	if !strings.Contains(prompt, "User sent an image.") || !strings.Contains(prompt, "file_cache_dir/wechat/wechat_21_0_image.png") {
		t.Fatalf("prompt does not name the image: %q", prompt)
	}
	saved, err := os.ReadFile(filepath.Join(cacheDir, "wechat", "wechat_21_0_image.png"))
	if err != nil || string(saved) != string(picture) {
		t.Fatalf("saved image = %q, %v", saved, err)
	}
}

func TestSendFileUploadsAfterTheCaption(t *testing.T) {
	var sent []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ilink/bot/getuploadurl":
			_, _ = io.WriteString(w, `{"ret":0,"upload_param":"UP"}`)
		case "/c2c/upload":
			w.Header().Set("x-encrypted-param", "DL")
		case "/ilink/bot/sendmessage":
			var body struct {
				Msg map[string]any `json:"msg"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			sent = append(sent, body.Msg)
			_, _ = io.WriteString(w, `{"ret":0}`)
		}
	}))
	defer server.Close()
	client, err := wechatapi.NewClient("tok", wechatapi.Options{BaseURL: server.URL, CDNBaseURL: server.URL + "/c2c", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	tr := newTransport(client, "bot", slog.New(slog.NewTextHandler(io.Discard, nil)))
	path := filepath.Join(t.TempDir(), "chart.png")
	_ = os.WriteFile(path, []byte("png"), 0o600)
	file := accountdm.OutboundFile{Path: path, Name: "chart.png", MIMEType: "image/png", Caption: "here it is"}
	if err := tr.SendFile(context.Background(), "bot", "o9u@im.wechat", file); err == nil {
		t.Fatal("sent without a conversation context")
	}
	tr.contexts.Store("o9u@im.wechat", "c")
	if err := tr.SendFile(context.Background(), "bot", "o9u@im.wechat", file); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 {
		t.Fatalf("sent %d messages", len(sent))
	}
	first := sent[0]["item_list"].([]any)[0].(map[string]any)
	second := sent[1]["item_list"].([]any)[0].(map[string]any)
	if first["type"] != float64(wechatapi.ItemText) || second["type"] != float64(wechatapi.ItemImage) {
		t.Fatalf("sent items = %v, %v", first, second)
	}
}

// Message is the wire shape the fake decodes replies into.
type Message = wechatapi.Message

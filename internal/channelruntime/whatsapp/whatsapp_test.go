package whatsapp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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
	"github.com/quailyquaily/mistermorph/internal/whatsappapi"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type stubLLM struct{}

func (stubLLM) Chat(context.Context, llm.Request) (llm.Result, error) {
	return llm.Result{Text: `{"type":"final","output":"hello back"}`}, nil
}

type mapReader map[string]string

func (m mapReader) GetString(key string) string { return m[key] }

const now = 1790000000

type fakePlatform struct {
	mu        sync.Mutex
	polls     int
	sent      []map[string]any
	base      string
	downloads int
}

func (f *fakePlatform) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/updates":
			f.polls++
			switch {
			case f.polls <= 2: // the same batch twice, as a replay
				fmt.Fprintf(w, `{"object":"whatsapp_agent_platform","entry":[{"id":"123","changes":[{"field":"messages","value":{
					"contacts":[{"wa_id":"user:509","profile":{"name":"Alex"}}],
					"messages":[
						{"from":"user:509","id":"wamid.OLD","timestamp":"%d","type":"text","text":{"body":"from last month"}},
						{"from":"user:509","id":"wamid.A","timestamp":"%d","type":"text","text":{"body":"hi"}},
						{"from":"user:509","id":"wamid.B","timestamp":"%d","type":"image","image":{"id":"m1","mime_type":"image/jpeg"}},
						{"from":"user:509","id":"wamid.C","timestamp":"%d","type":"reaction","reaction":{"message_id":"wamid.X","emoji":"👍"}}
					],"statuses":[]}}]}],"next_offset":7}`, now-40*86400, now-60, now-50, now-40)
			case f.polls < 5 || len(f.sent) < 2:
				w.WriteHeader(http.StatusNoContent)
			default:
				w.WriteHeader(http.StatusConflict)
				_, _ = io.WriteString(w, `{"error":{"code":1752041}}`)
			}
		case "/media/m1":
			fmt.Fprintf(w, `{"url":"%s/content/m1","mime_type":"image/jpeg","file_size":4,"id":"m1"}`, f.base)
		case "/content/m1":
			f.downloads++
			_, _ = w.Write([]byte{0xff, 0xd8, 0xff, 0xe0})
		case "/messages":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.sent = append(f.sent, body)
			_, _ = io.WriteString(w, `{"messages":[{"id":"wamid.OUT"}]}`)
		}
	}
}

func (f *fakePlatform) texts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, body := range f.sent {
		quote := ""
		if ctx, ok := body["context"].(map[string]any); ok {
			quote = ctx["message_id"].(string)
		}
		out = append(out, body["to"].(string)+"|"+quote+"|"+body["text"].(map[string]any)["body"].(string))
	}
	return out
}

func TestRuntimeAnswersTheCreatorAndStopsWhenAnotherPollerTakesOver(t *testing.T) {
	fake := &fakePlatform{}
	server := httptest.NewServer(fake.handler())
	defer server.Close()
	fake.base = server.URL
	// The client's rate limits run on a clock that sleeping moves forward.
	var clockMu sync.Mutex
	clock := time.Unix(now, 0)
	client, err := whatsappapi.NewClient("tok", whatsappapi.Options{
		BaseURL: server.URL, HTTPClient: server.Client(),
		Now: func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return clock },
		Sleep: func(_ context.Context, d time.Duration) error {
			clockMu.Lock()
			defer clockMu.Unlock()
			clock = clock.Add(d)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	cacheDir := t.TempDir()
	paths := runtimepaths.FromReader(mapReader{"file_state_dir": t.TempDir(), "file_cache_dir": cacheDir})
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
	store, _ := daemonruntime.NewTaskViewForTarget("whatsapp", 10, daemonruntime.TaskViewConfig{TasksDir: paths.TasksDir, JournalDir: paths.JournalDir})
	done := make(chan error, 1)
	go func() {
		done <- Run(context.Background(), deps, RunOptions{
			APIToken: "tok", Options: accountdm.Options{TaskStore: store, FileCacheDir: cacheDir}, client: client,
			now: func() time.Time { return time.Unix(now, 0) },
		})
	}()
	var runErr error
	select {
	case runErr = <-done:
	case <-time.After(20 * time.Second):
		t.Fatalf("Run did not stop when another poller took over; sent %q, downloads %d", fake.texts(), fake.downloads)
	}
	if runErr == nil || !strings.Contains(runErr.Error(), "another poll") {
		t.Fatalf("Run() = %v", runErr)
	}
	texts := fake.texts()
	joined := strings.Join(texts, "\n")
	if strings.Count(joined, "hello back") != 2 || !strings.Contains(joined, "user:509|wamid.A|hello back") {
		t.Fatalf("sent = %q", texts)
	}
	// The image starts a task of its own, and is downloaded once although the batch is replayed.
	if !strings.Contains(joined, "user:509|wamid.B|hello back") || fake.downloads != 1 {
		t.Fatalf("image not answered once (downloads %d): %q", fake.downloads, texts)
	}
	// The replayed batch is not answered again, the reaction never, and the old message is skipped.
	if len(texts) != 2 || strings.Contains(joined, "from last month") {
		t.Fatalf("sent = %q", texts)
	}
}

package consolecmd

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/spf13/viper"
)

func TestConsoleMaxConcurrencyFromReader(t *testing.T) {
	withDefaults := func(set func(*viper.Viper)) *viper.Viper {
		reader := viper.New()
		configdefaults.Apply(reader)
		if set != nil {
			set(reader)
		}
		return reader
	}
	for _, tc := range []struct {
		name   string
		reader *viper.Viper
		want   int
	}{
		{name: "nil reader", reader: nil, want: 8},
		{name: "no defaults", reader: viper.New(), want: 8},
		{name: "omitted", reader: withDefaults(nil), want: 8},
		{name: "serial", reader: withDefaults(func(r *viper.Viper) { r.Set("console.max_concurrency", 1) }), want: 1},
		{name: "explicit", reader: withDefaults(func(r *viper.Viper) { r.Set("console.max_concurrency", 5) }), want: 5},
		{name: "zero", reader: withDefaults(func(r *viper.Viper) { r.Set("console.max_concurrency", 0) }), want: 8},
		{name: "negative", reader: withDefaults(func(r *viper.Viper) { r.Set("console.max_concurrency", -4) }), want: 8},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got int
			if tc.reader == nil {
				got = consoleMaxConcurrencyFromReader(nil)
			} else {
				got = consoleMaxConcurrencyFromReader(tc.reader)
			}
			if got != tc.want {
				t.Fatalf("consoleMaxConcurrencyFromReader() = %d, want %d", got, tc.want)
			}
		})
	}
	if configdefaults.DefaultChannelMaxConcurrency != 8 {
		t.Fatalf("shared default = %d, want 8", configdefaults.DefaultChannelMaxConcurrency)
	}
}

var concurrencyMarkerPattern = regexp.MustCompile(`conc-[a-z]+-[a-z0-9]+`)

// concurrencyProvider is a fake LLM. A task whose message has a conc-block-<id> marker stays
// in its model request until released; conc-fail-<id> fails; anything else answers at once.
type concurrencyProvider struct {
	mu       sync.Mutex
	requests map[string][]string
	entered  map[string]chan struct{}
	release  map[string]chan struct{}
}

func newConcurrencyProvider() *concurrencyProvider {
	return &concurrencyProvider{
		requests: map[string][]string{},
		entered:  map[string]chan struct{}{},
		release:  map[string]chan struct{}{},
	}
}

func (p *concurrencyProvider) channels(marker string) (chan struct{}, chan struct{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.entered[marker] == nil {
		p.entered[marker] = make(chan struct{}, 1)
		p.release[marker] = make(chan struct{})
	}
	return p.entered[marker], p.release[marker]
}

func (p *concurrencyProvider) Release(marker string) {
	_, release := p.channels(marker)
	close(release)
}

func (p *concurrencyProvider) WaitEntered(t *testing.T, marker string) {
	t.Helper()
	entered, _ := p.channels(marker)
	waitConsoleGenerationTestSignal(t, entered, marker+" model request")
}

func (p *concurrencyProvider) Requests(marker string) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.requests[marker]...)
}

func (p *concurrencyProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
		Stream bool `json:"stream"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	raw, _ := json.Marshal(req.Messages)
	output := `{"title":"Concurrency","icon":"book-open"}`
	if strings.Contains(string(raw), "console_task_id") && len(req.Messages) > 0 {
		marker := concurrencyMarkerPattern.FindString(req.Messages[len(req.Messages)-1].Content)
		p.mu.Lock()
		p.requests[marker] = append(p.requests[marker], string(raw))
		p.mu.Unlock()
		switch {
		case strings.HasPrefix(marker, "conc-block-"):
			entered, release := p.channels(marker)
			select {
			case entered <- struct{}{}:
			default:
			}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		case strings.HasPrefix(marker, "conc-fail-"):
			// Rate limits are not retried on the same profile, so the task fails at once.
			http.Error(w, `{"error":{"message":"rate limit: simulated failure","type":"rate_limit_error"}}`, http.StatusTooManyRequests)
			return
		}
		output = fmt.Sprintf(`{"type":"final","output":"answer for %s","is_lightweight":false}`, marker)
	}
	if req.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk, _ := json.Marshal(map[string]any{"id": "fake", "object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": output}, "finish_reason": "stop"}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"id": "fake", "choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": output}, "finish_reason": "stop"}}})
}

type concurrencyHarness struct {
	rt       *consoleLocalRuntime
	client   sharedTopicsHTTPClient
	provider *concurrencyProvider
	reader   func(limit any) *viper.Viper
}

// newConcurrencyHarness starts a real Console runtime (bus, runner, agent, store) on a fake
// provider. limit is the console.max_concurrency value; nil leaves it unset.
func newConcurrencyHarness(t *testing.T, limit any) concurrencyHarness {
	t.Helper()
	provider := newConcurrencyProvider()
	fake := httptest.NewServer(provider)
	t.Cleanup(fake.Close)
	stateDir, cacheDir, workspaceDir := t.TempDir(), t.TempDir(), t.TempDir()
	makeReader := func(limit any) *viper.Viper {
		reader := consoleRuntimeBoundaryReader(stateDir, cacheDir)
		reader.Set("workspace_dir", workspaceDir)
		reader.Set("llm.endpoint", fake.URL+"/v1")
		reader.Set("llm.api_key", "fake-concurrency-key")
		reader.Set("llm.request_timeout", "10s")
		reader.Set("logging.file.enabled", false)
		if limit != nil {
			reader.Set("console.max_concurrency", limit)
		}
		return reader
	}
	oldLogger := slog.Default()
	rt, err := newConsoleLocalRuntime(serveConfig{}, makeReader(limit))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rt.Close(); slog.SetDefault(oldLogger) })
	// Resolve the handler per request so the client follows generation reloads.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.StripPrefix("/runtime", rt.currentHandler()).ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	return concurrencyHarness{
		rt:       rt,
		client:   sharedTopicsHTTPClient{t: t, base: server.URL + "/runtime", token: rt.currentAuthToken(), http: &http.Client{Transport: transport, Timeout: 15 * time.Second}},
		provider: provider,
		reader:   makeReader,
	}
}

func (h concurrencyHarness) status(id string) daemonruntime.TaskStatus {
	var task daemonruntime.TaskInfo
	h.client.ok("GET", "/tasks/"+id, nil, &task)
	return task.Status
}

func (h concurrencyHarness) waitQueuedForSlot(t *testing.T, waiting int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for h.rt.taskLimiter.Waiting() != waiting {
		if time.Now().After(deadline) {
			t.Fatalf("topics waiting for a slot = %d, want %d", h.rt.taskLimiter.Waiting(), waiting)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h concurrencyHarness) reload(t *testing.T, limit any) {
	t.Helper()
	generation, err := h.rt.prepareGeneration(h.reader(limit))
	if err != nil {
		t.Fatal(err)
	}
	if err := h.rt.applyPreparedGeneration(generation); err != nil {
		generation.cleanupNow()
		t.Fatal(err)
	}
}

func TestConsoleTaskConcurrencyIndependentTopicRunsPastBlockedTopic(t *testing.T) {
	h := newConcurrencyHarness(t, nil)
	if got := h.rt.taskLimiter.Limit(); got != 8 {
		t.Fatalf("default console task limit = %d, want 8", got)
	}
	workspaceA, workspaceB := t.TempDir(), t.TempDir()
	a := h.client.submit("", "conc-block-alpha waits on a slow tool", workspaceA)
	h.provider.WaitEntered(t, "conc-block-alpha")
	h.client.wait(a.ID, daemonruntime.TaskRunning)

	b := h.client.submit("", "conc-free-beta", workspaceB)
	doneB := h.client.wait(b.ID, daemonruntime.TaskDone)
	if status := h.status(a.ID); status != daemonruntime.TaskRunning {
		t.Fatalf("blocked task status = %s after the other topic finished, want running", status)
	}
	if a.TopicID == b.TopicID || doneB.TopicID != b.TopicID || !strings.Contains(fmt.Sprint(doneB.Result), "answer for conc-free-beta") {
		t.Fatalf("topic B result = %+v (topic A %s)", doneB, a.TopicID)
	}

	h.provider.Release("conc-block-alpha")
	doneA := h.client.wait(a.ID, daemonruntime.TaskDone)
	if doneA.TopicID != a.TopicID || !strings.Contains(fmt.Sprint(doneA.Result), "answer for conc-block-alpha") {
		t.Fatalf("topic A result = %+v", doneA)
	}

	// Each run saw only its own topic and workspace.
	for marker, want := range map[string][2]string{
		"conc-block-alpha": {workspaceA, workspaceB},
		"conc-free-beta":   {workspaceB, workspaceA},
	} {
		requests := h.provider.Requests(marker)
		if len(requests) == 0 {
			t.Fatalf("%s sent no model request", marker)
		}
		other := "conc-free-beta"
		if marker == other {
			other = "conc-block-alpha"
		}
		for _, raw := range requests {
			if !strings.Contains(raw, want[0]) || strings.Contains(raw, want[1]) || strings.Contains(raw, other) {
				t.Fatalf("%s request mixes topics or workspaces: %s", marker, raw)
			}
		}
	}
	for topicID, taskID := range map[string]string{a.TopicID: a.ID, b.TopicID: b.ID} {
		var page struct {
			Items []daemonruntime.TaskInfo `json:"items"`
		}
		h.client.ok("GET", "/tasks?topic_id="+topicID+"&limit=10", nil, &page)
		if len(page.Items) != 1 || page.Items[0].ID != taskID {
			t.Fatalf("topic %s tasks = %+v, want only %s", topicID, page.Items, taskID)
		}
	}
	var workspace daemonruntime.WorkspaceResolution
	h.client.ok("GET", "/workspace?topic_id="+a.TopicID, nil, &workspace)
	if workspace.WorkspaceDir != workspaceA {
		t.Fatalf("topic A workspace = %+v, want %s", workspace, workspaceA)
	}
	h.client.ok("GET", "/workspace?topic_id="+b.TopicID, nil, &workspace)
	if workspace.WorkspaceDir != workspaceB {
		t.Fatalf("topic B workspace = %+v, want %s", workspace, workspaceB)
	}
}

func TestConsoleTaskConcurrencyLimitAppliesAcrossReloads(t *testing.T) {
	h := newConcurrencyHarness(t, 1)
	runner := h.rt.runner
	limiter := h.rt.taskLimiter
	if got := limiter.Limit(); got != 1 {
		t.Fatalf("explicit console task limit = %d, want 1", got)
	}
	a := h.client.submit("", "conc-block-alpha", "")
	h.provider.WaitEntered(t, "conc-block-alpha")
	b := h.client.submit("", "conc-free-beta", "")
	h.waitQueuedForSlot(t, 1)
	if status := h.status(b.ID); status != daemonruntime.TaskQueued {
		t.Fatalf("second topic status = %s with limit 1, want queued", status)
	}
	if got := h.provider.Requests("conc-free-beta"); len(got) != 0 {
		t.Fatalf("second topic reached the model with limit 1: %d requests", len(got))
	}

	// Raising the limit on reload starts the queued topic without touching the running one.
	h.reload(t, 2)
	if h.rt.runner != runner || h.rt.taskLimiter != limiter || limiter.Limit() != 2 {
		t.Fatalf("reload replaced runner/limiter or kept limit %d, want same runner with limit 2", limiter.Limit())
	}
	h.client.wait(b.ID, daemonruntime.TaskDone)
	if status := h.status(a.ID); status != daemonruntime.TaskRunning {
		t.Fatalf("running task status after reload = %s, want running", status)
	}
	h.provider.Release("conc-block-alpha")
	h.client.wait(a.ID, daemonruntime.TaskDone)

	for _, tc := range []struct {
		limit any
		want  int
	}{{limit: 0, want: 8}, {limit: -1, want: 8}, {limit: nil, want: 8}, {limit: 3, want: 3}, {limit: 1, want: 1}} {
		h.reload(t, tc.limit)
		if got := limiter.Limit(); got != tc.want {
			t.Fatalf("limit after reload with %v = %d, want %d", tc.limit, got, tc.want)
		}
	}
	// Work keeps flowing on the same runner after the reloads.
	c := h.client.submit(a.TopicID, "conc-free-gamma", "")
	h.client.wait(c.ID, daemonruntime.TaskDone)
	if active, waiting := limiter.Active(), limiter.Waiting(); active != 0 || waiting != 0 {
		t.Fatalf("slots active=%d waiting=%d after all tasks ended, want 0 0", active, waiting)
	}
}

func TestConsoleTaskConcurrencyStopAndFailureReleaseSlot(t *testing.T) {
	h := newConcurrencyHarness(t, 1)
	a := h.client.submit("", "conc-block-alpha", "")
	h.provider.WaitEntered(t, "conc-block-alpha")
	b := h.client.submit("", "conc-block-beta", "")
	h.waitQueuedForSlot(t, 1)

	// Stopping the running task hands its slot to the queued topic.
	var stop daemonruntime.StopTaskResponse
	h.client.ok("POST", "/topics/"+a.TopicID+"/stop", nil, &stop)
	if !stop.Found {
		t.Fatalf("stop = %+v, want found", stop)
	}
	h.client.wait(a.ID, daemonruntime.TaskCanceled)
	h.provider.WaitEntered(t, "conc-block-beta")

	// A failing task releases its slot too.
	c := h.client.submit("", "conc-fail-gamma", "")
	h.waitQueuedForSlot(t, 1)
	h.provider.Release("conc-block-beta")
	h.client.wait(b.ID, daemonruntime.TaskDone)
	h.client.wait(c.ID, daemonruntime.TaskFailed)
	d := h.client.submit("", "conc-free-delta", "")
	h.client.wait(d.ID, daemonruntime.TaskDone)
	if active, waiting := h.rt.taskLimiter.Active(), h.rt.taskLimiter.Waiting(); active != 0 || waiting != 0 {
		t.Fatalf("slots active=%d waiting=%d after all tasks ended, want 0 0", active, waiting)
	}
}

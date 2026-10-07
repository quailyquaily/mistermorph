package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/llm"
)

const runtimeAPITestToken = "test-token"

func newRuntimeAPITestServer(t *testing.T, cfg Config, chat func(context.Context, llm.Request) (llm.Result, error)) (*runtimeAPI, *httptest.Server) {
	t.Helper()
	rt := newRuntimeWithStubIntegrationClient(cfg, chat)
	api, err := rt.newRuntimeAPI(context.Background(), RuntimeAPIOptions{})
	if err != nil {
		t.Fatalf("newRuntimeAPI() error = %v", err)
	}
	srv := httptest.NewServer(daemonruntime.NewHandler(api.routes()))
	t.Cleanup(func() {
		srv.Close()
		api.close()
	})
	return api, srv
}

func runtimeAPITestConfig(t *testing.T) Config {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Features.Skills = false
	cfg.Set("file_state_dir", t.TempDir())
	cfg.Set("llm.provider", "openai")
	cfg.Set("llm.model", "gpt-5.2")
	cfg.Set("server.auth_token", runtimeAPITestToken)
	return cfg
}

func runtimeAPIRequest(t *testing.T, srv *httptest.Server, method, path string, body any) (int, []byte) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, srv.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+runtimeAPITestToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes()
}

func submitRuntimeAPITask(t *testing.T, srv *httptest.Server, req daemonruntime.SubmitTaskRequest) daemonruntime.SubmitTaskResponse {
	t.Helper()
	status, raw := runtimeAPIRequest(t, srv, http.MethodPost, "/tasks", req)
	if status != http.StatusOK {
		t.Fatalf("POST /tasks status = %d, body = %s", status, raw)
	}
	var resp daemonruntime.SubmitTaskResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func waitRuntimeAPITask(t *testing.T, api *runtimeAPI, id string, want daemonruntime.TaskStatus) daemonruntime.TaskInfo {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if info, ok := api.store.Get(id); ok && info != nil && info.Status == want {
			return *info
		}
		time.Sleep(10 * time.Millisecond)
	}
	info, _ := api.store.Get(id)
	t.Fatalf("task %s did not reach %s: %+v", id, want, info)
	return daemonruntime.TaskInfo{}
}

func TestServeRuntimeAPIRequiresListenAndToken(t *testing.T) {
	cfg := runtimeAPITestConfig(t)
	rt := newRuntimeWithStubIntegrationClient(cfg, nil)
	if err := rt.ServeRuntimeAPI(context.Background(), RuntimeAPIOptions{}); err == nil || !strings.Contains(err.Error(), "server.listen") {
		t.Fatalf("ServeRuntimeAPI() error = %v, want server.listen error", err)
	}

	cfg.Set("server.listen", "127.0.0.1:0")
	cfg.Set("server.auth_token", "")
	rt = newRuntimeWithStubIntegrationClient(cfg, nil)
	if err := rt.ServeRuntimeAPI(context.Background(), RuntimeAPIOptions{}); err == nil || !strings.Contains(err.Error(), "server.auth_token") {
		t.Fatalf("ServeRuntimeAPI() error = %v, want server.auth_token error", err)
	}
}

func TestRuntimeAPIHealthAndAuth(t *testing.T) {
	_, srv := newRuntimeAPITestServer(t, runtimeAPITestConfig(t), nil)

	resp, err := srv.Client().Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var health struct {
		Mode          string `json:"mode"`
		SubmitEnabled bool   `json:"submit_enabled"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if health.Mode != "integration" || !health.SubmitEnabled {
		t.Fatalf("health = %+v, want integration mode with submit enabled", health)
	}

	unauthorized, err := srv.Client().Get(srv.URL + "/tasks")
	if err != nil {
		t.Fatal(err)
	}
	unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET /tasks without token status = %d, want 401", unauthorized.StatusCode)
	}
}

func TestRuntimeAPIChatCarriesTopicHistory(t *testing.T) {
	var mu sync.Mutex
	var requests []llm.Request
	chat := func(_ context.Context, req llm.Request) (llm.Result, error) {
		mu.Lock()
		requests = append(requests, req)
		n := len(requests)
		mu.Unlock()
		if n == 1 {
			return llm.Result{Text: `{"type":"final","output":"Nice to meet you, Ada."}`}, nil
		}
		return llm.Result{Text: `{"type":"final","output":"Your name is Ada."}`}, nil
	}
	api, srv := newRuntimeAPITestServer(t, runtimeAPITestConfig(t), chat)

	first := submitRuntimeAPITask(t, srv, daemonruntime.SubmitTaskRequest{Task: "My name is Ada."})
	if first.TopicID == "" || first.Status != daemonruntime.TaskQueued {
		t.Fatalf("first submit = %+v, want a new topic and queued status", first)
	}
	done := waitRuntimeAPITask(t, api, first.ID, daemonruntime.TaskDone)
	if got := runtimeAPITaskOutput(done.Result); got != "Nice to meet you, Ada." {
		t.Fatalf("first output = %q", got)
	}
	if done.Model != "gpt-5.2" {
		t.Fatalf("first model = %q, want the resolved gpt-5.2", done.Model)
	}
	topic, ok := api.store.GetTopic(first.TopicID)
	if !ok || topic.Title != "My name is Ada." {
		t.Fatalf("topic = %+v, want titled after the first message", topic)
	}

	second := submitRuntimeAPITask(t, srv, daemonruntime.SubmitTaskRequest{Task: "What is my name?", TopicID: first.TopicID})
	waitRuntimeAPITask(t, api, second.ID, daemonruntime.TaskDone)

	mu.Lock()
	last := requests[len(requests)-1]
	mu.Unlock()
	var sawFirstTask, sawFirstAnswer bool
	for _, msg := range last.Messages {
		if msg.Role == "user" && msg.Content == "My name is Ada." {
			sawFirstTask = true
		}
		if msg.Role == "assistant" && msg.Content == "Nice to meet you, Ada." {
			sawFirstAnswer = true
		}
	}
	if !sawFirstTask || !sawFirstAnswer {
		t.Fatalf("second request misses the first exchange: %+v", last.Messages)
	}

	status, raw := runtimeAPIRequest(t, srv, http.MethodGet, "/tasks?topic_id="+first.TopicID, nil)
	if status != http.StatusOK || !strings.Contains(string(raw), second.ID) || !strings.Contains(string(raw), first.ID) {
		t.Fatalf("GET /tasks status = %d, body = %s", status, raw)
	}
}

func TestRuntimeAPIRejectsBadSubmissions(t *testing.T) {
	_, srv := newRuntimeAPITestServer(t, runtimeAPITestConfig(t), nil)
	for name, tc := range map[string]struct {
		req  daemonruntime.SubmitTaskRequest
		want string
	}{
		"unknown topic":  {daemonruntime.SubmitTaskRequest{Task: "hi", TopicID: "missing"}, "topic not found"},
		"attached files": {daemonruntime.SubmitTaskRequest{Task: "hi", FileReferences: []daemonruntime.FileReference{{}}}, "attached files"},
		"bad timeout":    {daemonruntime.SubmitTaskRequest{Task: "hi", Timeout: "soon"}, "invalid timeout"},
	} {
		t.Run(name, func(t *testing.T) {
			status, raw := runtimeAPIRequest(t, srv, http.MethodPost, "/tasks", tc.req)
			if status != http.StatusBadRequest || !strings.Contains(string(raw), tc.want) {
				t.Fatalf("status = %d, body = %s, want 400 %q", status, raw, tc.want)
			}
		})
	}
}

func TestRuntimeAPIStopCancelsRunningTask(t *testing.T) {
	started := make(chan struct{}, 1)
	chat := func(ctx context.Context, _ llm.Request) (llm.Result, error) {
		started <- struct{}{}
		<-ctx.Done()
		return llm.Result{}, ctx.Err()
	}
	api, srv := newRuntimeAPITestServer(t, runtimeAPITestConfig(t), chat)

	resp := submitRuntimeAPITask(t, srv, daemonruntime.SubmitTaskRequest{Task: "wait"})
	<-started
	status, raw := runtimeAPIRequest(t, srv, http.MethodPost, "/tasks/"+resp.ID+"/stop", daemonruntime.StopTaskRequest{TaskID: resp.ID})
	if status != http.StatusOK {
		t.Fatalf("stop status = %d, body = %s", status, raw)
	}
	waitRuntimeAPITask(t, api, resp.ID, daemonruntime.TaskCanceled)
}

func TestRuntimeAPIQueueLimit(t *testing.T) {
	release := make(chan struct{})
	chat := func(ctx context.Context, _ llm.Request) (llm.Result, error) {
		select {
		case <-release:
		case <-ctx.Done():
			return llm.Result{}, ctx.Err()
		}
		return llm.Result{Text: `{"type":"final","output":"ok"}`}, nil
	}
	cfg := runtimeAPITestConfig(t)
	cfg.Set("server.max_queue", 1)
	api, srv := newRuntimeAPITestServer(t, cfg, chat)

	first := submitRuntimeAPITask(t, srv, daemonruntime.SubmitTaskRequest{Task: "one"})
	status, raw := runtimeAPIRequest(t, srv, http.MethodPost, "/tasks", daemonruntime.SubmitTaskRequest{Task: "two"})
	if status != http.StatusServiceUnavailable || !strings.Contains(string(raw), "queue is full") {
		t.Fatalf("second submit status = %d, body = %s, want 503 queue is full", status, raw)
	}
	close(release)
	waitRuntimeAPITask(t, api, first.ID, daemonruntime.TaskDone)
}

func TestRuntimeAPIListsProgramTasksAndRecoversOnlyItsOwn(t *testing.T) {
	cfg := runtimeAPITestConfig(t)
	chat := func(context.Context, llm.Request) (llm.Result, error) {
		return llm.Result{Text: `{"type":"final","output":"from the program"}`}, nil
	}
	rt := newRuntimeWithStubIntegrationClient(cfg, chat)
	if _, err := rt.RunTaskWithOptions(context.Background(), "program task", RunTaskOptions{TaskID: "program_task", PersistTask: true}); err != nil {
		t.Fatal(err)
	}

	api, err := rt.newRuntimeAPI(context.Background(), RuntimeAPIOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// A task the API left running, and one the program is running now.
	if err := api.store.UpsertWithTrigger(daemonruntime.TaskInfo{ID: "stale_api", Status: daemonruntime.TaskRunning, Task: "x"},
		daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := api.store.UpsertWithTrigger(daemonruntime.TaskInfo{ID: "live_program", Status: daemonruntime.TaskRunning, Task: "y"},
		daemonruntime.TaskTrigger{Source: "integration", Event: "run_task"}, ""); err != nil {
		t.Fatal(err)
	}
	api.close()

	api, err = rt.newRuntimeAPI(context.Background(), RuntimeAPIOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer api.close()
	if info, ok := api.store.Get("program_task"); !ok || info.Status != daemonruntime.TaskDone {
		t.Fatalf("program_task = %+v, want listed as done", info)
	}
	if info, _ := api.store.Get("stale_api"); info == nil || info.Status != daemonruntime.TaskCanceled {
		t.Fatalf("stale_api = %+v, want canceled", info)
	}
	if info, _ := api.store.Get("live_program"); info == nil || info.Status != daemonruntime.TaskRunning {
		t.Fatalf("live_program = %+v, want left running", info)
	}
}

type runtimeAPITestTool struct{}

func (runtimeAPITestTool) Name() string            { return "lookup_order" }
func (runtimeAPITestTool) Description() string     { return "Looks up an order." }
func (runtimeAPITestTool) ParameterSchema() string { return `{"type":"object","properties":{}}` }
func (runtimeAPITestTool) Execute(context.Context, map[string]any) (string, error) {
	return "shipped", nil
}

func TestRuntimeAPIRunsWithTheProgramTools(t *testing.T) {
	seen := make(chan []string, 1)
	chat := func(_ context.Context, req llm.Request) (llm.Result, error) {
		names := make([]string, 0, len(req.Tools))
		for _, tool := range req.Tools {
			names = append(names, tool.Name)
		}
		select {
		case seen <- names:
		default:
		}
		return llm.Result{Text: `{"type":"final","output":"ok"}`}, nil
	}
	rt := newRuntimeWithStubIntegrationClient(runtimeAPITestConfig(t), chat)
	reg := rt.NewRegistry()
	if err := reg.Register(runtimeAPITestTool{}); err != nil {
		t.Fatal(err)
	}
	api, err := rt.newRuntimeAPI(context.Background(), RuntimeAPIOptions{Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(daemonruntime.NewHandler(api.routes()))
	defer func() {
		srv.Close()
		api.close()
	}()

	resp := submitRuntimeAPITask(t, srv, daemonruntime.SubmitTaskRequest{Task: "Where is my order?"})
	waitRuntimeAPITask(t, api, resp.ID, daemonruntime.TaskDone)
	names := <-seen
	found := false
	for _, name := range names {
		if name == "lookup_order" {
			found = true
		}
	}
	if !found {
		t.Fatalf("tools = %v, want lookup_order", names)
	}
}

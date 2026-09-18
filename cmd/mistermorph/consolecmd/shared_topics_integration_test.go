package consolecmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/chattrace"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/llm"
)

// These are HTTP contract tests, not browser or terminal UI tests. Both clients
// talk to a real Console runtime (bus, runner, agent, store and workspace routes).
// Only the provider is fake; all state and workspace paths are temporary.
type sharedTopicsProvider struct {
	mu       sync.Mutex
	requests []llm.Request
	entered  chan struct{}
	release  chan struct{}
}

func (p *sharedTopicsProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Messages []llm.Message `json:"messages"`
		Stream   bool          `json:"stream"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	raw, _ := json.Marshal(req.Messages)
	isTask := strings.Contains(string(raw), "console_task_id")
	if isTask {
		p.mu.Lock()
		p.requests = append(p.requests, llm.Request{Messages: req.Messages})
		p.mu.Unlock()
		if strings.Contains(req.Messages[len(req.Messages)-1].Content, "acceptance-block") {
			select {
			case p.entered <- struct{}{}:
			default:
			}
			select {
			case <-p.release:
			case <-r.Context().Done():
				return
			}
		}
	}
	output := `{"title":"Shared acceptance","icon":"book-open"}`
	if len(req.Messages) > 0 && strings.HasPrefix(req.Messages[0].Content, "Create one context checkpoint") {
		output = `{"summary":"acceptance-checkpoint-summary","user_intent":["continue"],"references":{"files":[],"directories":[],"urls":[]},"progress":{"completed":[],"in_progress":[],"pending":[]},"intermediate_results":[]}`
	}
	if isTask {
		output = `{"type":"final","output":"acceptance-answer","is_lightweight":false}`
	}
	if isTask && strings.Contains(req.Messages[len(req.Messages)-1].Content, "acceptance-approval") {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"id":"fake","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"approval-call","type":"function","function":{"name":"bash","arguments":"{\"cmd\":\"printf acceptance-approved\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		return
	}
	if req.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk, _ := json.Marshal(map[string]any{"id": "fake", "object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": output}, "finish_reason": "stop"}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
	} else {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "fake", "choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": output}, "finish_reason": "stop"}}})
	}
}

func (p *sharedTopicsProvider) snapshot() []llm.Request {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]llm.Request(nil), p.requests...)
}

type sharedTopicsHTTPClient struct {
	t           *testing.T
	base, token string
	http        *http.Client
}

func (c sharedTopicsHTTPClient) request(method, path string, body, out any) int {
	c.t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, c.base+path, bytes.NewReader(data))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatal(err)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			c.t.Fatalf("%s %s: %s: %v", method, path, raw, err)
		}
	}
	return resp.StatusCode
}
func (c sharedTopicsHTTPClient) ok(method, path string, body, out any) {
	c.t.Helper()
	if status := c.request(method, path, body, out); status < 200 || status >= 300 {
		c.t.Fatalf("%s %s: HTTP %d", method, path, status)
	}
}
func (c sharedTopicsHTTPClient) submit(topic, text, workspace string) daemonruntime.SubmitTaskResponse {
	c.t.Helper()
	var out daemonruntime.SubmitTaskResponse
	c.ok("POST", "/tasks", daemonruntime.SubmitTaskRequest{TopicID: topic, Task: text, WorkspaceDir: workspace}, &out)
	if out.ID == "" || out.TopicID == "" {
		c.t.Fatalf("missing server IDs: %+v", out)
	}
	return out
}
func (c sharedTopicsHTTPClient) wait(id string, status daemonruntime.TaskStatus) daemonruntime.TaskInfo {
	c.t.Helper()
	var task daemonruntime.TaskInfo
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		c.ok("GET", "/tasks/"+id, nil, &task)
		if task.Status == status {
			return task
		}
		if task.Status == daemonruntime.TaskFailed || task.Status == daemonruntime.TaskCanceled || task.Status == daemonruntime.TaskDone {
			c.t.Fatalf("task %s: status=%s error=%q, want %s", id, task.Status, task.Error, status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	c.t.Fatalf("task %s timed out: %+v", id, task)
	return task
}
func newSharedTopicsAcceptance(t *testing.T) (sharedTopicsHTTPClient, sharedTopicsHTTPClient, *sharedTopicsProvider, string) {
	t.Helper()
	provider := &sharedTopicsProvider{entered: make(chan struct{}, 8), release: make(chan struct{})}
	fake := httptest.NewServer(provider)
	t.Cleanup(fake.Close)
	reader := consoleRuntimeBoundaryReader(t.TempDir(), t.TempDir())
	workspace := t.TempDir()
	reader.Set("workspace_dir", workspace)
	reader.Set("llm.endpoint", fake.URL+"/v1")
	reader.Set("llm.api_key", "fake-acceptance-key")
	reader.Set("logging.file.enabled", false)
	reader.Set("context_compaction.enabled", true)
	reader.Set("guard.enabled", true)
	reader.Set("guard.approvals.enabled", true)
	reader.Set("tools.bash.enabled", true)
	oldLogger := slog.Default()
	rt, err := newConsoleLocalRuntime(serveConfig{}, reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rt.Close(); slog.SetDefault(oldLogger) })
	// Exercise a non-root base URL without replacing the runtime handler.
	mux := http.NewServeMux()
	mux.Handle("/nested/runtime/", http.StripPrefix("/nested/runtime", rt.currentHandler()))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := func() sharedTopicsHTTPClient {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		t.Cleanup(transport.CloseIdleConnections)
		return sharedTopicsHTTPClient{t: t, base: server.URL + "/nested/runtime", token: rt.currentAuthToken(), http: &http.Client{Transport: transport, Timeout: 15 * time.Second}}
	}
	return client(), client(), provider, workspace
}

func TestSharedTopicsIntegrationCreateContinueAndWorkspace(t *testing.T) {
	a, b, provider, defaultDir := newSharedTopicsAcceptance(t)
	attached := t.TempDir()
	first := a.submit("", "acceptance-alpha-original", attached)
	done := b.wait(first.ID, daemonruntime.TaskDone)
	if done.TopicID != first.TopicID || done.FinishedAt == nil || !strings.Contains(fmt.Sprint(done.Result), "acceptance-answer") {
		t.Fatalf("completed task: %+v", done)
	}
	// Opening and paging shared history must not invoke the model.
	before := len(provider.snapshot())
	var topic daemonruntime.TopicInfo
	b.ok("GET", "/topics/"+first.TopicID, nil, &topic)
	if topic.ID != first.TopicID {
		t.Fatalf("topic: %+v", topic)
	}
	var page struct {
		Items      []daemonruntime.TaskInfo `json:"items"`
		HasNext    bool                     `json:"has_next"`
		NextCursor string                   `json:"next_cursor"`
	}
	b.ok("GET", "/tasks?topic_id="+first.TopicID+"&limit=1", nil, &page)
	if len(page.Items) != 1 || page.Items[0].ID != first.ID {
		t.Fatalf("history: %+v", page)
	}
	if len(provider.snapshot()) != before {
		t.Fatal("read-only requests invoked LLM")
	}
	second := b.submit(first.TopicID, "acceptance-alpha-continue", "")
	a.wait(second.ID, daemonruntime.TaskDone)
	other := b.submit("", "acceptance-beta-isolated", attached)
	a.wait(other.ID, daemonruntime.TaskDone)
	var topics struct {
		Items []daemonruntime.TopicInfo `json:"items"`
	}
	a.ok("GET", "/topics?limit=100", nil, &topics)
	found := false
	for _, item := range topics.Items {
		if item.ID == other.TopicID {
			found = true
		}
	}
	if !found {
		t.Fatal("topic created by second client absent from first client's list")
	}
	if other.TopicID == first.TopicID {
		t.Fatal("new topic reused existing ID")
	}
	requests := provider.snapshot()
	if len(requests) != 3 {
		t.Fatalf("task model requests=%d, want 3", len(requests))
	}
	messages := func(i int) string { raw, _ := json.Marshal(requests[i].Messages); return string(raw) }
	if !strings.Contains(messages(1), "acceptance-alpha-original") || !strings.Contains(messages(1), "acceptance-answer") {
		t.Fatal("second client did not restore shared context")
	}
	if strings.Contains(messages(2), "acceptance-alpha") || strings.Contains(messages(2), "acceptance-answer") {
		t.Fatal("same-workspace topics leaked context")
	}
	if !strings.Contains(messages(0), attached) {
		t.Fatal("first task did not execute with requested server workspace")
	}
	b.ok("GET", "/tasks?topic_id="+first.TopicID+"&limit=1", nil, &page)
	if len(page.Items) != 1 || page.Items[0].ID != second.ID || !page.HasNext || page.NextCursor == "" {
		t.Fatalf("newest history page: %+v", page)
	}
	b.ok("GET", "/tasks?topic_id="+first.TopicID+"&limit=1&cursor="+url.QueryEscape(page.NextCursor), nil, &page)
	if len(page.Items) != 1 || page.Items[0].ID != first.ID || page.HasNext {
		t.Fatalf("older history page: %+v", page)
	}
	var resolution daemonruntime.WorkspaceResolution
	a.ok("GET", "/workspace?topic_id="+first.TopicID, nil, &resolution)
	if resolution.WorkspaceDir != attached || resolution.Source != "attachment" {
		t.Fatalf("shared attachment: %+v", resolution)
	}
	changed := t.TempDir()
	b.ok("PUT", "/workspace", map[string]string{"topic_id": first.TopicID, "workspace_dir": changed}, nil)
	third := a.submit(first.TopicID, "acceptance-alpha-after-attach", "")
	b.wait(third.ID, daemonruntime.TaskDone)
	requests = provider.snapshot()
	raw, _ := json.Marshal(requests[len(requests)-1].Messages)
	if !strings.Contains(string(raw), changed) {
		t.Fatal("continuation ignored attachment changed by other client")
	}
	a.ok("DELETE", "/workspace?topic_id="+first.TopicID, nil, nil)
	b.ok("GET", "/workspace?topic_id="+first.TopicID, nil, &resolution)
	if resolution.WorkspaceDir != defaultDir || resolution.Source != "default" {
		t.Fatalf("detach: %+v", resolution)
	}
	if status := a.request("POST", "/tasks", daemonruntime.SubmitTaskRequest{Task: "invalid-workspace", WorkspaceDir: filepath.Join(t.TempDir(), "missing")}, nil); status != 400 {
		t.Fatalf("invalid server workspace HTTP %d", status)
	}
}

func TestSharedTopicsIntegrationStopIsolationAndSteer(t *testing.T) {
	a, b, provider, _ := newSharedTopicsAcceptance(t)
	other := b.submit("", "acceptance-other-completed", "")
	b.wait(other.ID, daemonruntime.TaskDone)
	active := a.submit("", "acceptance-block-active", "")
	waitConsoleGenerationTestSignal(t, provider.entered, "active LLM request")
	b.wait(active.ID, daemonruntime.TaskRunning)
	// Closing the sending client's connections and reading another topic do not stop execution.
	a.http.CloseIdleConnections()
	var topic daemonruntime.TopicInfo
	b.ok("GET", "/topics/"+other.TopicID, nil, &topic)
	var stop daemonruntime.StopTaskResponse
	b.ok("POST", "/topics/"+other.TopicID+"/stop", nil, &stop)
	if stop.Found {
		t.Fatalf("stopped unrelated task: %+v", stop)
	}
	b.wait(active.ID, daemonruntime.TaskRunning)
	steer := b.submit(active.TopicID, "acceptance-steer-shorter", "")
	if steer.SteerTargetTaskID != active.ID || steer.Status != daemonruntime.TaskDone {
		t.Fatalf("steer response: %+v", steer)
	}
	stored := a.wait(steer.ID, daemonruntime.TaskDone)
	if stored.SteerTargetTaskID != active.ID {
		t.Fatalf("lost steer association: %+v", stored)
	}
	b.ok("POST", "/topics/"+active.TopicID+"/stop", nil, &stop)
	if !stop.Found || stop.TopicID != active.TopicID || stop.Status != "stopping" {
		t.Fatalf("target stop: %+v", stop)
	}
	canceled := b.wait(active.ID, daemonruntime.TaskCanceled)
	if canceled.Error != "stopped by user" || canceled.FinishedAt == nil {
		t.Fatalf("canceled: %+v", canceled)
	}
	a.wait(other.ID, daemonruntime.TaskDone)
	// A new sender can continue after cancellation; stopping is not a topic tombstone.
	resumed := b.submit(active.TopicID, "acceptance-after-stop", "")
	a.wait(resumed.ID, daemonruntime.TaskDone)
}

func TestSharedTopicsIntegrationCheckpointAcrossClients(t *testing.T) {
	a, b, provider, _ := newSharedTopicsAcceptance(t)
	first := a.submit("", "acceptance-covered-original", "")
	b.wait(first.ID, daemonruntime.TaskDone)
	compact := b.submit(first.TopicID, "/ctx compact", "")
	done := a.wait(compact.ID, daemonruntime.TaskDone)
	if !strings.Contains(fmt.Sprint(done.Result), "Context compacted.") {
		t.Fatalf("compaction result: %+v", done)
	}
	next := a.submit(first.TopicID, "acceptance-after-checkpoint", "")
	b.wait(next.ID, daemonruntime.TaskDone)
	requests := provider.snapshot()
	raw, _ := json.Marshal(requests[len(requests)-1].Messages)
	if strings.Count(string(raw), "acceptance-checkpoint-summary") != 1 {
		t.Fatalf("checkpoint not restored exactly once: %s", raw)
	}
	if strings.Contains(string(raw), "acceptance-covered-original") || strings.Contains(string(raw), "acceptance-answer") {
		t.Fatalf("covered history replayed after checkpoint: %s", raw)
	}
	other := b.submit("", "acceptance-without-checkpoint", "")
	a.wait(other.ID, daemonruntime.TaskDone)
	requests = provider.snapshot()
	raw, _ = json.Marshal(requests[len(requests)-1].Messages)
	if strings.Contains(string(raw), "acceptance-checkpoint-summary") {
		t.Fatal("checkpoint leaked into other topic")
	}
}

func TestSharedTopicsIntegrationDeleteRunningTopic(t *testing.T) {
	a, b, provider, _ := newSharedTopicsAcceptance(t)
	active := a.submit("", "acceptance-block-delete", t.TempDir())
	waitConsoleGenerationTestSignal(t, provider.entered, "task to delete")
	b.ok("DELETE", "/topics/"+active.TopicID, nil, nil)
	if status := a.request("GET", "/topics/"+active.TopicID, nil, nil); status != 404 {
		t.Fatalf("deleted topic HTTP %d", status)
	}
	// Task records remain addressable after topic deletion for audit.
	a.wait(active.ID, daemonruntime.TaskCanceled)
	if status := a.request("POST", "/tasks", daemonruntime.SubmitTaskRequest{TopicID: active.TopicID, Task: "must not recreate"}, nil); status != 400 {
		t.Fatalf("submission to deleted topic HTTP %d", status)
	}
	var resolution daemonruntime.WorkspaceResolution
	a.ok("GET", "/workspace?topic_id="+active.TopicID, nil, &resolution)
	if resolution.Source == "attachment" {
		t.Fatal("deleted topic retained attachment")
	}
}

func TestSharedTopicsIntegrationPendingApproval(t *testing.T) {
	for _, decision := range []string{"approve", "deny"} {
		t.Run(decision, func(t *testing.T) {
			a, b, _, _ := newSharedTopicsAcceptance(t)
			task := a.submit("", "acceptance-approval", "")
			pending := b.wait(task.ID, daemonruntime.TaskPending)
			if pending.ApprovalRequestID == "" || pending.PendingAt == nil {
				t.Fatalf("missing pending details: %+v", pending)
			}
			var approval daemonruntime.ApprovalInfo
			b.ok("GET", "/approvals/"+pending.ApprovalRequestID, nil, &approval)
			if approval.TaskID != task.ID || approval.Status != "pending" || approval.ToolName != "bash" {
				t.Fatalf("approval: %+v", approval)
			}
			b.ok("POST", "/approvals/"+pending.ApprovalRequestID+"/"+decision, map[string]string{"actor": "acceptance-client-b"}, nil)
			want := daemonruntime.TaskDone
			if decision == "deny" {
				want = daemonruntime.TaskCanceled
			}
			terminal := a.wait(task.ID, want)
			if terminal.TopicID != task.TopicID || terminal.PendingAt != nil {
				t.Fatalf("approval resolution changed task identity or retained pending: %+v", terminal)
			}
			var before, after struct {
				Trace chattrace.Snapshot `json:"trace"`
			}
			raw, _ := json.Marshal(pending.Result)
			_ = json.Unmarshal(raw, &before)
			raw, _ = json.Marshal(terminal.Result)
			_ = json.Unmarshal(raw, &after)
			if len(before.Trace.Entries) == 0 || len(after.Trace.Entries) < len(before.Trace.Entries) {
				t.Fatalf("approval lost execution records: before=%d after=%d", len(before.Trace.Entries), len(after.Trace.Entries))
			}
			for i, entry := range before.Trace.Entries {
				if entry.Seq != after.Trace.Entries[i].Seq || entry.Event.Kind != after.Trace.Entries[i].Event.Kind {
					t.Fatal("approval replaced earlier execution records")
				}
			}
			if decision == "approve" && len(after.Trace.Entries) == len(before.Trace.Entries) {
				t.Fatal("approval resume did not append execution records")
			}
		})
	}
}

func TestSharedTopicsIntegrationRejectUnknownTopic(t *testing.T) {
	a, _, provider, _ := newSharedTopicsAcceptance(t)
	for _, text := range []string{"must not create topic", "/help", "/ctx compact"} {
		status := a.request("POST", "/tasks", daemonruntime.SubmitTaskRequest{TopicID: "missing-acceptance-topic", Task: text}, nil)
		if status != 400 {
			t.Fatalf("unknown topic submission %q: HTTP %d", text, status)
		}
	}
	if len(provider.snapshot()) != 0 {
		t.Fatal("unknown topic submission invoked model")
	}
}

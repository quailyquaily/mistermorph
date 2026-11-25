package consolecmd

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
)

// soloProvider is a fake model for Solo. The run's newest message picks what it does:
//   - "solo-dispatch <dir>": call work_thread for "thread-block" work in <dir>, then answer;
//   - "solo-recall <topic id>": find topic_read, read that topic, then answer from it;
//   - "thread-block": wait until released, then answer "Report ready: 42 pages";
//   - anything else: answer "answer for <message>" at once.
type soloProvider struct {
	mu       sync.Mutex
	requests []string
	entered  chan struct{}
	release  chan struct{}
}

func newSoloProvider() *soloProvider {
	return &soloProvider{entered: make(chan struct{}, 4), release: make(chan struct{})}
}

func (p *soloProvider) snapshot() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.requests...)
}

func (p *soloProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Messages []llm.Message `json:"messages"`
		Stream   bool          `json:"stream"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	raw, _ := json.Marshal(req.Messages)
	output := `{"title":"Solo","icon":"book-open"}`
	if strings.Contains(string(raw), "console_task_id") && len(req.Messages) > 0 {
		p.mu.Lock()
		p.requests = append(p.requests, string(raw))
		p.mu.Unlock()
		last := req.Messages[len(req.Messages)-1]
		userText := ""
		for i := len(req.Messages) - 1; i >= 0; i-- {
			if req.Messages[i].Role == "user" {
				userText = req.Messages[i].Content
				break
			}
		}
		toolDone := last.Role == "tool"
		toolResults := 0
		for i := len(req.Messages) - 1; i >= 0 && req.Messages[i].Role != "user"; i-- {
			if req.Messages[i].Role == "tool" {
				toolResults++
			}
		}
		switch {
		case strings.Contains(userText, "solo-dispatch") && !toolDone:
			dir := strings.TrimSpace(userText[strings.Index(userText, "solo-dispatch")+len("solo-dispatch"):])
			if cut := strings.IndexAny(dir, " \n\"\\"); cut >= 0 {
				dir = dir[:cut]
			}
			args, _ := json.Marshal(map[string]any{"title": "Build report", "task": "thread-block build the report", "workspace": dir})
			writeSoloToolCall(w, "work_thread", string(args))
			return
		case strings.Contains(userText, "solo-recall") && toolResults == 0:
			// topic_read is deferred: found with tool_search first, as a model does.
			writeSoloToolCall(w, "tool_search", `{"query":"topic_read"}`)
			return
		case strings.Contains(userText, "solo-recall") && toolResults == 1:
			id := strings.TrimSpace(userText[strings.Index(userText, "solo-recall")+len("solo-recall"):])
			if cut := strings.IndexAny(id, " \n\"\\"); cut >= 0 {
				id = id[:cut]
			}
			args, _ := json.Marshal(map[string]any{"topic_id": id})
			writeSoloToolCall(w, "topic_read", string(args))
			return
		case strings.Contains(userText, "thread-block"):
			select {
			case p.entered <- struct{}{}:
			default:
			}
			select {
			case <-p.release:
			case <-r.Context().Done():
				return
			}
			output = `{"type":"final","output":"Report ready: 42 pages","is_lightweight":false}`
		case toolDone && strings.Contains(userText, "solo-dispatch"):
			output = `{"type":"final","output":"I started a thread for the report.","is_lightweight":false}`
		case toolResults == 2 && strings.Contains(userText, "solo-recall"):
			output = `{"type":"final","output":"The pricing topic settled on 12 dollars.","is_lightweight":false}`
		default:
			marker := strings.Join(strings.Fields(userText), " ")
			if len(marker) > 40 {
				marker = marker[len(marker)-40:]
			}
			output = fmt.Sprintf(`{"type":"final","output":%q,"is_lightweight":false}`, "answer for "+marker)
		}
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

func writeSoloToolCall(w http.ResponseWriter, name, args string) {
	call, _ := json.Marshal(map[string]any{"id": "fake", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{
		"index": 0, "id": "call-" + name, "type": "function", "function": map[string]any{"name": name, "arguments": args},
	}}}, "finish_reason": "tool_calls"}}})
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", call)
}

type soloHarness struct {
	rt       *consoleLocalRuntime
	client   sharedTopicsHTTPClient
	provider *soloProvider
	soloWS   string
	stateDir string
}

func newSoloHarness(t *testing.T) soloHarness {
	t.Helper()
	provider := newSoloProvider()
	fake := httptest.NewServer(provider)
	t.Cleanup(fake.Close)
	t.Cleanup(func() {
		select {
		case <-provider.release:
		default:
			close(provider.release)
		}
	})
	stateDir, cacheDir, soloWS := t.TempDir(), t.TempDir(), t.TempDir()
	reader := consoleRuntimeBoundaryReader(stateDir, cacheDir)
	reader.Set("workspace_dir", soloWS)
	reader.Set("llm.endpoint", fake.URL+"/v1")
	reader.Set("llm.api_key", "fake-solo-key")
	reader.Set("llm.request_timeout", "10s")
	reader.Set("logging.file.enabled", false)
	oldLogger := slog.Default()
	rt, err := newConsoleLocalRuntime(serveConfig{}, reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rt.Close(); rt.soloSyncs.Wait(); slog.SetDefault(oldLogger) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.StripPrefix("/runtime", rt.currentHandler()).ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	return soloHarness{
		rt:       rt,
		client:   sharedTopicsHTTPClient{t: t, base: server.URL + "/runtime", token: rt.currentAuthToken(), http: &http.Client{Transport: transport, Timeout: 15 * time.Second}},
		provider: provider,
		soloWS:   soloWS,
		stateDir: stateDir,
	}
}

// chat sends a message as the Console chat does.
func (h soloHarness) chat(topicID, text string) daemonruntime.SubmitTaskResponse {
	h.client.t.Helper()
	var out daemonruntime.SubmitTaskResponse
	h.client.ok("POST", "/tasks", daemonruntime.SubmitTaskRequest{
		TopicID: topicID,
		Task:    text,
		Trigger: &daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: consoleChatTriggerRef},
	}, &out)
	if out.ID == "" {
		h.client.t.Fatalf("missing task id: %+v", out)
	}
	return out
}

func (h soloHarness) soloTasks() []daemonruntime.TaskInfo {
	var page struct {
		Items []daemonruntime.TaskInfo `json:"items"`
	}
	h.client.ok("GET", "/tasks?topic_id="+daemonruntime.ConsoleSoloTopicID+"&limit=100", nil, &page)
	return page.Items
}

func (h soloHarness) record(id string) (daemonruntime.SoloThread, bool) {
	var task daemonruntime.TaskInfo
	if status := h.client.request("GET", "/tasks/"+id, nil, &task); status != http.StatusOK {
		return daemonruntime.SoloThread{}, false
	}
	return soloThreadOf(task)
}

func (h soloHarness) waitRecord(t *testing.T, id string, state string) daemonruntime.SoloThread {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if rec, ok := h.record(id); ok && rec.State == state {
			return rec
		}
		time.Sleep(10 * time.Millisecond)
	}
	rec, _ := h.record(id)
	t.Fatalf("record %s = %+v, want state %s", id, rec, state)
	return rec
}

func soloSourcesOf(t *testing.T, task daemonruntime.TaskInfo) []daemonruntime.SoloSource {
	t.Helper()
	raw, err := json.Marshal(task.Result)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Sources []daemonruntime.SoloSource `json:"solo_sources"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out.Sources
}

func TestSoloIsListedFirstTimeAndOpensByID(t *testing.T) {
	h := newSoloHarness(t)
	var page struct {
		Items []daemonruntime.TopicInfo `json:"items"`
	}
	h.client.ok("GET", "/topics?limit=50", nil, &page)
	if len(page.Items) != 1 || page.Items[0].ID != daemonruntime.ConsoleSoloTopicID || page.Items[0].Title != "Solo" {
		t.Fatalf("topics = %+v, want Solo made on the first listing", page.Items)
	}
	var topic daemonruntime.TopicInfo
	h.client.ok("GET", "/topics/"+daemonruntime.ConsoleSoloTopicID, nil, &topic)
	if topic.ID != daemonruntime.ConsoleSoloTopicID {
		t.Fatalf("GET Solo = %+v", topic)
	}
	// Solo is the runtime's: it is not deleted or renamed, and listing again makes no second one.
	if status := h.client.request("DELETE", "/topics/"+daemonruntime.ConsoleSoloTopicID, nil, nil); status < 400 && status != http.StatusNotFound {
		if _, ok := h.rt.store.GetTopic(daemonruntime.ConsoleSoloTopicID); !ok {
			t.Fatalf("DELETE Solo = %d and it went", status)
		}
	}
	if status := h.client.request("PUT", "/topics/"+daemonruntime.ConsoleSoloTopicID+"/title", map[string]string{"title": "Mine"}, nil); status != http.StatusBadRequest {
		t.Fatalf("rename Solo = HTTP %d, want 400", status)
	}
	h.client.ok("GET", "/topics?limit=50", nil, &page)
	if len(page.Items) != 1 || page.Items[0].Title != "Solo" {
		t.Fatalf("topics after delete and rename = %+v", page.Items)
	}
}

// Solo is on the first page of the topic list however many topics are newer, and every topic is
// listed once across the pages.
func TestSoloIsOnTheFirstPageAfterManyTopics(t *testing.T) {
	h := newSoloHarness(t)
	for i := 0; i < 5; i++ {
		if _, err := h.rt.store.CreateNamedTopic(fmt.Sprintf("Older %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	h.rt.ensureSoloTopic()
	for i := 0; i < 100; i++ {
		if _, err := h.rt.store.CreateNamedTopic(fmt.Sprintf("Newer %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	// The store's own first page of 100 does not reach Solo.
	for _, topic := range h.rt.store.ListTopicsPage(daemonruntime.TopicListOptions{Limit: 100}) {
		if topic.ID == daemonruntime.ConsoleSoloTopicID {
			t.Fatal("setup: Solo is within the store's first 100 topics")
		}
	}
	for _, limit := range []int{100, 3, 2, 1, 200} {
		t.Run(fmt.Sprint("limit ", limit), func(t *testing.T) {
			seen := map[string]int{}
			cursor, pages := "", 0
			for {
				var page struct {
					Items      []daemonruntime.TopicInfo `json:"items"`
					NextCursor string                    `json:"next_cursor"`
				}
				path := fmt.Sprintf("/topics?limit=%d", limit)
				if cursor != "" {
					path += "&cursor=" + url.QueryEscape(cursor)
				}
				h.client.ok("GET", path, nil, &page)
				if pages == 0 && limit > 1 && (len(page.Items) == 0 || page.Items[0].ID != daemonruntime.ConsoleSoloTopicID) {
					t.Fatalf("first page starts %+v, want Solo", page.Items[:1])
				}
				if len(page.Items) > limit {
					t.Fatalf("page %d has %d topics, limit %d", pages, len(page.Items), limit)
				}
				for _, topic := range page.Items {
					seen[topic.ID]++
				}
				pages++
				if page.NextCursor == "" || pages > 200 {
					break
				}
				cursor = page.NextCursor
			}
			if len(seen) != 106 {
				t.Fatalf("listed %d topics over %d pages, want 106 (5 older, Solo, 100 newer)", len(seen), pages)
			}
			for id, n := range seen {
				if n != 1 {
					t.Fatalf("topic %s listed %d times", id, n)
				}
			}
		})
	}
}

func TestSoloStartsWorkThreadThatRunsWhileSoloAnswers(t *testing.T) {
	h := newSoloHarness(t)
	project := t.TempDir()

	// The Solo message names the project; the agent starts a thread there and answers at once.
	dispatch := h.chat(daemonruntime.ConsoleSoloTopicID, "solo-dispatch "+project+" please build the report")
	done := h.client.wait(dispatch.ID, daemonruntime.TaskDone)
	if !strings.Contains(fmt.Sprint(done.Result), "I started a thread") {
		t.Fatalf("Solo reply = %+v", done.Result)
	}
	select {
	case <-h.provider.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the thread's task did not reach the model")
	}

	// The card: one per thread, after the Solo turn, following the thread's task.
	var card daemonruntime.TaskInfo
	for _, task := range h.soloTasks() {
		if strings.HasPrefix(task.ID, daemonruntime.SoloThreadCardPrefix) {
			card = task
		}
	}
	rec, ok := soloThreadOf(card)
	if !ok || rec.Title != "Build report" || rec.OriginTaskID != dispatch.ID || rec.State != daemonruntime.SoloThreadRunning {
		t.Fatalf("card = %+v (%+v)", rec, card)
	}
	if rec.WorkspaceDir != project || rec.Continued {
		t.Fatalf("card workspace = %q continued=%v, want %s", rec.WorkspaceDir, rec.Continued, project)
	}
	if card.Status != daemonruntime.TaskDone || card.Task != "" || !card.CreatedAt.After(done.CreatedAt) {
		t.Fatalf("card task = %+v", card)
	}
	// The thread: an ordinary topic named for the work, marked as Solo's, with the workspace.
	thread, ok := h.rt.store.GetTopic(rec.TopicID)
	if !ok || thread.Title != "Build report" || thread.StartedFrom != daemonruntime.ConsoleSoloTopicID {
		t.Fatalf("thread topic = %+v", thread)
	}
	var ws daemonruntime.WorkspaceResolution
	h.client.ok("GET", "/workspace?topic_id="+rec.TopicID, nil, &ws)
	if ws.WorkspaceDir != project {
		t.Fatalf("thread workspace = %+v, want %s", ws, project)
	}
	if status := h.client.wait(rec.TaskID, daemonruntime.TaskRunning).Status; status != daemonruntime.TaskRunning {
		t.Fatalf("thread task = %s", status)
	}
	// Its chips: the thread it started.
	sources := soloSourcesOf(t, done)
	if len(sources) != 1 || sources[0].Kind != daemonruntime.SoloSourceThread || sources[0].ID != rec.TopicID || sources[0].Label != "Build report" {
		t.Fatalf("Solo chips = %+v", sources)
	}

	// Solo answers the next message while the thread still works.
	hello := h.chat(daemonruntime.ConsoleSoloTopicID, "solo-hello how are you")
	if answered := h.client.wait(hello.ID, daemonruntime.TaskDone); !strings.Contains(fmt.Sprint(answered.Result), "answer for") {
		t.Fatalf("second Solo reply = %+v", answered.Result)
	}
	if status := h.client.wait(rec.TaskID, daemonruntime.TaskRunning).Status; status != daemonruntime.TaskRunning {
		t.Fatalf("thread task after Solo's second answer = %s", status)
	}

	// The thread ends: its card says done, and its summary comes to Solo, once.
	close(h.provider.release)
	h.client.wait(rec.TaskID, daemonruntime.TaskDone)
	doneCard := h.waitRecord(t, card.ID, daemonruntime.SoloThreadDone)
	if !strings.Contains(doneCard.Summary, "Report ready: 42 pages") || doneCard.FinishedAt == "" {
		t.Fatalf("done card = %+v", doneCard)
	}
	summary := h.waitRecord(t, daemonruntime.SoloThreadSummaryID(rec.TaskID), daemonruntime.SoloThreadDone)
	if summary.Kind != daemonruntime.SoloRecordSummary || summary.TopicID != rec.TopicID || !strings.Contains(summary.Summary, "42 pages") {
		t.Fatalf("summary = %+v", summary)
	}
	h.rt.soloSyncs.Wait()
	h.rt.syncSoloThread(rec.TaskID)
	h.rt.reconcileSoloThreads()
	summaries := 0
	for _, task := range h.soloTasks() {
		if strings.HasPrefix(task.ID, daemonruntime.SoloThreadSummaryPrefix) {
			summaries++
		}
	}
	if summaries != 1 {
		t.Fatalf("summaries in Solo = %d, want 1", summaries)
	}

	// The next Solo run is told about the thread and what it came to; the thread's own
	// conversation stays in the thread.
	next := h.chat(daemonruntime.ConsoleSoloTopicID, "solo-after what came of it")
	h.client.wait(next.ID, daemonruntime.TaskDone)
	var soloRequest, threadRequest string
	for _, raw := range h.provider.snapshot() {
		if strings.Contains(raw, "solo-after") {
			soloRequest = raw
		}
		if threadRequest == "" && strings.Contains(raw, "thread-block build the report") && !strings.Contains(raw, "solo-dispatch") {
			threadRequest = raw
		}
	}
	if !strings.Contains(soloRequest, "Recent work threads") || !strings.Contains(soloRequest, rec.TopicID) || !strings.Contains(soloRequest, "42 pages") {
		t.Fatalf("Solo prompt lacks the thread: %s", soloRequest)
	}
	if threadRequest == "" || strings.Contains(threadRequest, "how are you") {
		t.Fatalf("thread request = %q", threadRequest)
	}
}

func TestSoloAnswersFromAnotherTopicWithItsChip(t *testing.T) {
	h := newSoloHarness(t)
	pricing, err := h.rt.store.CreateNamedTopic("Pricing")
	if err != nil {
		t.Fatal(err)
	}
	earlier := h.chat(pricing.ID, "what should the plan cost")
	h.client.wait(earlier.ID, daemonruntime.TaskDone)

	recall := h.chat(daemonruntime.ConsoleSoloTopicID, "solo-recall "+pricing.ID+" what did we settle on")
	done := h.client.wait(recall.ID, daemonruntime.TaskDone)
	if !strings.Contains(fmt.Sprint(done.Result), "12 dollars") {
		t.Fatalf("reply = %+v", done.Result)
	}
	sources := soloSourcesOf(t, done)
	if len(sources) != 1 || sources[0].Kind != daemonruntime.SoloSourceTopic || sources[0].ID != pricing.ID || sources[0].Label != "Pricing" {
		t.Fatalf("chips = %+v, want the Pricing topic", sources)
	}
	// An ordinary topic's reply carries no chips, and its runs have no work_thread.
	if got := soloSourcesOf(t, h.client.wait(earlier.ID, daemonruntime.TaskDone)); len(got) != 0 {
		t.Fatalf("ordinary topic chips = %+v", got)
	}
}

func TestSoloThreadSyncPostsFailuresOnceAndCatchesUpAfterRestart(t *testing.T) {
	rt, _, _ := newConsoleProgressPersistenceRuntime(t, nil, "work", false)
	if _, err := rt.store.EnsureSoloTopic(); err != nil {
		t.Fatal(err)
	}
	thread, err := rt.store.CreateThreadTopic("Migrate", daemonruntime.ConsoleSoloTopicID)
	if err != nil {
		t.Fatal(err)
	}
	trigger := daemonruntime.TaskTrigger{Source: "ui", Event: daemonruntime.SoloThreadTriggerEvent, Ref: consoleChatTriggerRef}
	cases := []struct {
		name    string
		status  daemonruntime.TaskStatus
		errText string
		reply   string
		state   string
		want    string
	}{
		{"failed", daemonruntime.TaskFailed, "model failed", "", daemonruntime.SoloThreadFailed, "model failed"},
		{"failed without a word", daemonruntime.TaskFailed, "", "", daemonruntime.SoloThreadFailed, "It stopped without saying why."},
		{"done without a reply", daemonruntime.TaskDone, "", "", daemonruntime.SoloThreadDone, "It finished without a reply."},
		{"stopped", daemonruntime.TaskCanceled, "stopped by user", "", daemonruntime.SoloThreadCanceled, "stopped by user"},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			taskID := fmt.Sprintf("thread_task_%d", i)
			if err := rt.store.UpsertWithTrigger(daemonruntime.TaskInfo{ID: taskID, TopicID: thread.ID, Task: "migrate", Status: daemonruntime.TaskRunning}, trigger, ""); err != nil {
				t.Fatal(err)
			}
			if err := rt.writeSoloThreadCard(daemonruntime.SoloThread{Kind: daemonruntime.SoloRecordCard, TopicID: thread.ID, TaskID: taskID, Title: "Migrate", Workspace: "~/db", State: daemonruntime.SoloThreadRunning}); err != nil {
				t.Fatal(err)
			}
			// The task ends while nothing watches (as after a restart): the check catches up.
			if err := rt.store.Update(taskID, func(info *daemonruntime.TaskInfo) {
				info.Status = c.status
				info.Error = c.errText
				if c.reply != "" {
					info.Result = map[string]any{"final": map[string]any{"output": c.reply}}
				}
			}); err != nil {
				t.Fatal(err)
			}
			rt.soloSyncs.Wait()
			rt.reconcileSoloThreads()
			rt.reconcileSoloThreads()
			rt.syncSoloThread(taskID)
			card, _ := rt.store.Get(daemonruntime.SoloThreadCardID(taskID))
			rec, _ := soloThreadOf(*card)
			if rec.State != c.state || !strings.Contains(rec.Summary, c.want) {
				t.Fatalf("card = %+v", rec)
			}
			summary, ok := rt.store.Get(daemonruntime.SoloThreadSummaryID(taskID))
			if !ok {
				t.Fatal("no summary")
			}
			srec, _ := soloThreadOf(*summary)
			if srec.State != c.state || !strings.Contains(srec.Summary, c.want) || summary.TopicID != daemonruntime.ConsoleSoloTopicID {
				t.Fatalf("summary = %+v in %s", srec, summary.TopicID)
			}
			n := 0
			for _, task := range rt.store.List(daemonruntime.TaskListOptions{TopicID: daemonruntime.ConsoleSoloTopicID, Limit: 100}) {
				if task.ID == daemonruntime.SoloThreadSummaryID(taskID) {
					n++
				}
			}
			if n != 1 {
				t.Fatalf("summaries = %d", n)
			}
		})
	}
}

func TestSoloThreadAsksBeforeWritingOutsideSolosWorkspace(t *testing.T) {
	rt, job, _ := newConsoleProgressPersistenceRuntime(t, nil, "work", false)
	soloWS, other := t.TempDir(), t.TempDir()
	rt.workspaceStore = workspace.NewStore(filepath.Join(t.TempDir(), "workspace_attachments.json"))
	if _, _, err := rt.workspaceStore.Set(buildConsoleConversationKey(daemonruntime.ConsoleSoloTopicID), workspace.Attachment{WorkspaceDir: soloWS}); err != nil {
		t.Fatal(err)
	}
	job.WorkspaceDir = other
	sw := rt.soloThreadWorkspaceSwitch(context.Background(), job, "")
	if dir, pending := sw.PendingApproval(); !pending || dir != other {
		t.Fatalf("thread in another workspace: pending=%v dir=%q", pending, dir)
	}
	sw.Approve(other)
	if _, pending := sw.PendingApproval(); pending {
		t.Fatal("still pending after approval")
	}
	job.WorkspaceDir = soloWS
	if _, pending := rt.soloThreadWorkspaceSwitch(context.Background(), job, "").PendingApproval(); pending {
		t.Fatal("a thread in Solo's own workspace asks")
	}
}

// File calls name the workspace only when their path is in it: not for the nest, the cache or
// state dirs, or absolute paths elsewhere.
func TestSoloSourceCollectorFilePaths(t *testing.T) {
	ws := t.TempDir()
	ctx := pathroots.WithWorkspaceDir(context.Background(), ws)
	link := filepath.Join(t.TempDir(), "ws-link")
	if err := os.Symlink(ws, link); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		tool, path string
		want       bool
	}{
		{"read_file", "notes.md", true},
		{"read_file", "./src/../notes.md", true},
		{"write_file", "workspace_dir/out.txt", true},
		{"read_file", "/workspace_dir/out.txt", true},
		{"read_file", filepath.Join(ws, "src", "main.go"), true},
		{"read_file", filepath.Join(link, "main.go"), true},
		{"read_file", "/var/lib/morph_nest/notes.md", false},
		{"read_file", "/etc/hosts", false},
		{"write_file", filepath.Join(filepath.Dir(ws), "sibling.txt"), false},
		{"write_file", ws + "-other/x.txt", false},
		{"read_file", "../outside.txt", false},
		{"read_file", "file_cache_dir/a.png", false},
		{"write_file", "file_state_dir/notes.md", false},
		{"read_file", "", false},
		{"bash", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.tool+" "+tc.path, func(t *testing.T) {
			c := newSoloSourceCollector("run1")
			event := agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: tc.tool, Text: "ok"}
			if tc.path != "" {
				event.Args = map[string]any{"path": tc.path}
			}
			c.HandleEvent(ctx, event)
			got := c.Sources()
			if tc.want != (len(got) == 1 && got[0].Kind == daemonruntime.SoloSourceWorkspace && got[0].ID == ws) || (!tc.want && len(got) != 0) {
				t.Fatalf("sources = %+v, want workspace chip %v", got, tc.want)
			}
		})
	}
}

func TestSoloSourceCollector(t *testing.T) {
	ws := t.TempDir()
	ctx := pathroots.WithWorkspaceDir(context.Background(), ws)
	c := newSoloSourceCollector("run1")
	done := func(name, text string) agent.Event {
		return agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: name, Text: text}
	}
	c.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: "read_file", Args: map[string]any{"path": "notes.md"}, Text: "x"})
	c.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: "read_file", Args: map[string]any{"path": "notes.md"}, Text: "again"})
	c.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: "read_file", Args: map[string]any{"path": "file_cache_dir/a.png"}})
	c.HandleEvent(ctx, done("workspace_use", `{"workspace_dir":"/srv/api","display":"/srv/api"}`))
	c.HandleEvent(ctx, done("topic_read", `{"topic":{"id":"t1","title":"Pricing"}}`))
	c.HandleEvent(ctx, done("work_thread", `{"topic_id":"t2","title":"Build"}`))
	c.HandleEvent(ctx, done("topic_read", `{"topic":{"id":"t2","title":"Build"}}`))
	c.HandleEvent(ctx, done("memory_search", "[]"))
	c.HandleEvent(ctx, done("journal_read", "x"))
	c.HandleEvent(ctx, done("journal_search", "x"))
	// Failed calls, other runs' calls, subagents' calls and starts are not used.
	c.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: "topic_read", Text: `{"topic":{"id":"t3"}}`, Error: "no topic"})
	c.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "other", ToolName: "topic_read", Text: `{"topic":{"id":"t4"}}`})
	c.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: "topic_read", Text: `{"topic":{"id":"t5"}}`, Worker: &agent.WorkerMetadata{ID: "w"}})
	c.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolStart, RunID: "run1", ToolName: "memory_save"})
	got := c.Sources()
	want := []daemonruntime.SoloSource{
		{Kind: "workspace", ID: ws, Label: ws},
		{Kind: "workspace", ID: "/srv/api", Label: "/srv/api"},
		{Kind: "topic", ID: "t1", Label: "Pricing"},
		{Kind: "thread", ID: "t2", Label: "Build"},
		{Kind: "memory"},
		{Kind: "journal"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("sources = %+v\nwant %+v", got, want)
	}
	// Without a workspace, file calls name none.
	bare := newSoloSourceCollector("run1")
	bare.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: "read_file", Args: map[string]any{"path": "notes.md"}})
	bare.HandleEvent(context.Background(), done("bash", "ok"))
	if got := bare.Sources(); len(got) != 0 {
		t.Fatalf("no-workspace sources = %+v", got)
	}
	var none *soloSourceCollector
	none.HandleEvent(ctx, done("memory_search", ""))
	if none.Sources() != nil {
		t.Fatal("nil collector has sources")
	}
}

func TestConsoleSoloRun(t *testing.T) {
	chat := daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: consoleChatTriggerRef}
	if !consoleSoloRun(consoleLocalTaskJob{TopicID: daemonruntime.ConsoleSoloTopicID, Trigger: chat}) {
		t.Fatal("Solo chat is not a Solo run")
	}
	if consoleSoloRun(consoleLocalTaskJob{TopicID: "t1", Trigger: chat}) {
		t.Fatal("an ordinary topic is a Solo run")
	}
	if consoleSoloRun(consoleLocalTaskJob{TopicID: daemonruntime.ConsoleSoloTopicID, Trigger: daemonruntime.TaskTrigger{Source: "agentlink"}}) {
		t.Fatal("an Agent Link task in Solo is a Solo run")
	}
}

func TestOrdinaryTopicRunHasNoWorkThread(t *testing.T) {
	rt, job, _ := newConsoleProgressPersistenceRuntime(t, []consoleProgressPersistenceLLMStep{
		{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "c1", Name: "work_thread", Arguments: map[string]any{"title": "x", "task": "y", "workspace": os.TempDir()}}}}},
		{result: llm.Result{Text: `{"type":"final","output":"done"}`}},
	}, "work", false)
	job.Trigger = daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: consoleChatTriggerRef}
	entries := ownerToolActivity(t, rt, job)
	if entry := entries["work_thread"]; entry.Error == "" {
		t.Fatalf("work_thread ran in an ordinary topic: %+v", entry)
	}
	if records := rt.soloThreadRecords(0); len(records) != 0 {
		t.Fatalf("records = %+v", records)
	}
}

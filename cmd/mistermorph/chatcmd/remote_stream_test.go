package chatcmd

import (
	tea "charm.land/bubbletea/v2"
	"context"
	"encoding/json"

	"fmt"
	"github.com/charmbracelet/x/ansi"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestRemoteStreamWireAndCancellation(t *testing.T) {
	closed := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/nested/runtime/stream/ws" || r.URL.Query().Get("task_id") != "task & one" || r.Header.Get("Authorization") != "Bearer secret" || strings.Contains(r.URL.String(), "secret") {
			t.Error("wrong stream request", r.URL)
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		conn.WriteJSON(map[string]any{"task_id": "task & one", "seq": 7, "text": "snapshot", "preview": true, "activity": map[string]any{"current": map[string]string{"name": "bash", "status": "running"}}})
		conn.ReadMessage()
		close(closed)
	}))
	defer srv.Close()
	c, _ := newRemoteClient(srv.URL+"/nested/runtime", "secret")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn, err := c.openStream(ctx, "task & one")
	if err != nil {
		t.Fatal(err)
	}
	var f remoteStreamFrame
	if err := conn.ReadJSON(&f); err != nil || f.Seq != 7 || f.Text != "snapshot" || f.Activity.Current.Name != "bash" {
		t.Fatalf("frame: %+v %v", f, err)
	}
	cancel()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("cancel did not close socket")
	}
}

func TestRemoteStreamRejectsRedirectAndRedactsErrors(t *testing.T) {
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer target.Close()
	for _, status := range []int{302, 401, 500} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", target.URL)
			w.WriteHeader(status)
			fmt.Fprint(w, "secret")
		}))
		c, _ := newRemoteClient(srv.URL, "secret")
		_, err := c.openStream(context.Background(), "task")
		srv.Close()
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("unsafe error: %v", err)
		}
	}
	if hits != 0 {
		t.Fatal("followed redirect")
	}
}

func streamTestModel(t *testing.T) *chatModel {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	m.id = "a"
	m.hasChat = true
	m.tasks["t"] = taskdomain.TaskInfo{ID: "t", TopicID: "a", Status: taskdomain.TaskRunning}
	m.syncStreams()
	t.Cleanup(m.closeStreams)
	return m
}
func TestRemoteStreamFilteringAndHTTPAuthority(t *testing.T) {
	m := streamTestModel(t)
	s := m.streams["t"]
	send := func(gen uint64, task string, seq uint64, text string) {
		m.Update(remoteStreamEvent{gen: gen, id: "t", sub: s, frame: remoteStreamFrame{TaskID: task, Seq: seq, Text: text}})
	}
	send(m.gen, "t", 2, "preview")
	send(m.gen, "t", 1, "old")
	send(m.gen, "wrong", 3, "wrong")
	send(m.gen-1, "t", 4, "stale")
	if s.text != "preview" || s.seq != 2 {
		t.Fatalf("filter failed: %+v", s)
	}
	m.Update(remoteStreamEvent{gen: m.gen, id: "t", sub: s, frame: remoteStreamFrame{TaskID: "t", Seq: 5, Text: "WS final", Done: true}})
	if m.tasks["t"].Status != taskdomain.TaskRunning || len(m.printed) != 0 {
		t.Fatal("WS became authoritative")
	}
	m.Update(remoteLoaded{gen: m.gen, id: "a", refresh: true, tasks: []taskdomain.TaskInfo{{ID: "t", TopicID: "a", Status: taskdomain.TaskDone, Result: map[string]any{"final": map[string]any{"output": "HTTP final"}}}}})
	if len(m.streams) != 0 || strings.Contains(m.streamView(), "WS final") {
		t.Fatal("terminal preview retained")
	}
	if m.printHistory(false) != nil {
		t.Fatal("duplicate HTTP final")
	}
	send(m.gen, "t", 6, "late")
	if len(m.streams) != 0 {
		t.Fatal("late frame resurrected subscription")
	}
}
func TestRemoteStreamLifecycleAndBounds(t *testing.T) {
	for _, action := range []string{"/topics", "/topic new", "/topic switch b", "/exit", "/quit"} {
		t.Run(action, func(t *testing.T) {
			m := streamTestModel(t)
			s := m.streams["t"]
			m.command(action)
			if s.ctx.Err() == nil || len(m.streams) != 0 {
				t.Fatal("view/exit retained stream")
			}
		})
	}
	m := streamTestModel(t)
	for i := 0; i < 20; i++ {
		id := fmt.Sprint(i)
		m.tasks[id] = taskdomain.TaskInfo{ID: id, TopicID: "a", Status: taskdomain.TaskPending}
	}
	m.tasks["foreign"] = taskdomain.TaskInfo{ID: "foreign", TopicID: "b", Status: taskdomain.TaskRunning}
	m.syncStreams()
	if len(m.streams) > remoteStreamLimit || m.streams["foreign"] != nil {
		t.Fatal("unbounded/foreign streams")
	}
	m.listing = true
	m.syncStreams()
	if len(m.streams) != 0 {
		t.Fatal("list has subscriptions")
	}
}

func TestRemoteStreamFailureStillPollsToFinal(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/stream/ws":
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
		case "/runtime/topics/a":
			fmt.Fprint(w, `{"id":"a"}`)
		case "/runtime/workspace":
			fmt.Fprint(w, `{"workspace_dir":"/repo"}`)
		case "/runtime/tasks":
			fmt.Fprint(w, `{"items":[{"id":"t","topic_id":"a","status":"done","result":{"final":{"output":"authoritative"}}}]}`)
		case "/runtime/tasks/t":
			fmt.Fprint(w, `{"id":"t","topic_id":"a","status":"done","result":{"final":{"output":"authoritative"}}}`)
		default:
			t.Errorf("unexpected request (including stop): %s", r.URL)
			http.NotFound(w, r)
		}
	})
	m.id = "a"
	m.hasChat = true
	m.tasks["t"] = taskdomain.TaskInfo{ID: "t", TopicID: "a", Status: taskdomain.TaskRunning}
	cmd := m.syncStreams()
	event := cmd().(remoteStreamEvent)
	m.Update(event)
	s := m.streams["t"]
	if !s.ended || s.retry.IsZero() || !strings.Contains(m.streamView(), "HTTP polling") {
		t.Fatal("missing fallback")
	}
	if m.syncStreams() != nil {
		t.Fatal("retried without backoff")
	}
	m.Update(m.load("a", true)())
	if m.tasks["t"].Status != taskdomain.TaskDone || len(m.streams) != 0 {
		t.Fatalf("HTTP failed to finish offline stream: status=%s task=%+v", m.notice, m.tasks["t"])
	}
	if !strings.Contains(m.printed["t:assistant"], "authoritative") || m.printHistory(false) != nil {
		t.Fatal("final not printed exactly once")
	}
}

func TestRemoteLiveStreamViewChangeClosesWithoutStop(t *testing.T) {
	for _, action := range []string{"/topics", "/topic new", "/topic switch b", "/exit"} {
		t.Run(action, func(t *testing.T) {
			closed := make(chan struct{})
			m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/runtime/stream/ws" {
					t.Errorf("unexpected request: %s", r.URL)
					http.NotFound(w, r)
					return
				}
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				conn.WriteJSON(map[string]any{"task_id": "t", "seq": 1, "text": "live"})
				conn.ReadMessage()
				close(closed)
			})
			m.id = "a"
			m.hasChat = true
			m.tasks["t"] = taskdomain.TaskInfo{ID: "t", TopicID: "a", Status: taskdomain.TaskRunning}
			event := m.syncStreams()().(remoteStreamEvent)
			_, wait := m.Update(event)
			m.command(action)
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("socket leaked")
			}
			done := make(chan struct{})
			go func() {
				if wait != nil {
					wait()
				}
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("stream command leaked")
			}
			m.Update(event)
			if len(m.streams) != 0 {
				t.Fatal("late frame recreated stream")
			}
		})
	}
}

func TestRemoteStreamReconnectIdentityAndSnapshots(t *testing.T) {
	m := streamTestModel(t)
	old := m.streams["t"]
	m.Update(remoteStreamEvent{gen: m.gen, id: "t", sub: old, err: fmt.Errorf("offline")})
	old.retry = time.Now().Add(-time.Second)
	if m.syncStreams() == nil {
		t.Fatal("no reconnect after backoff")
	}
	current := m.streams["t"]
	if current == old {
		t.Fatal("subscription identity reused")
	}
	m.Update(remoteStreamEvent{gen: m.gen, id: "t", sub: old, frame: remoteStreamFrame{TaskID: "t", Seq: 99, Text: "old connection"}})
	if current.seq != 0 {
		t.Fatal("old socket polluted reconnect")
	}
	for i, text := range []string{"first", "replacement"} {
		m.Update(remoteStreamEvent{gen: m.gen, id: "t", sub: current, frame: remoteStreamFrame{TaskID: "t", Seq: uint64(i + 1), Text: text}})
	}
	if current.text != "replacement" {
		t.Fatal("snapshot appended instead of replaced")
	}
	if got := remoteStreamSnippet("\x1b[31m"+strings.Repeat("界", 1000)+"\n", 40); len([]rune(got)) != 41 || strings.Contains(got, "\x1b") || strings.Contains(got, "\n") {
		t.Fatal("unsafe/unbounded preview")
	}
}

// Fixtures use Console's snapshot contract, not incremental tool events.
func TestRemoteStreamPresentationSnapshot(t *testing.T) {
	m := streamTestModel(t)
	send := func(raw string) {
		t.Helper()
		var f remoteStreamFrame
		if err := json.Unmarshal([]byte(raw), &f); err != nil {
			t.Fatal(err)
		}
		m.streamUpdate(remoteStreamEvent{gen: m.gen, id: "t", sub: m.streams["t"], frame: f})
	}
	send(`{"task_id":"t","seq":1,"reasoning":"Compare options\nChoose simple code","plan":{"steps":[{"step":"Inspect contract","status":"completed"},{"step":"Implement","status":"in_progress"}]},"activity":{"history":[{"id":"a","kind":"tool","name":"read_file","status":"completed","summary":"Read contract"},{"id":"b","kind":"tool","name":"bash","status":"running","output":"test output"}],"current":{"id":"b","kind":"tool","name":"bash","status":"running","output":"test output"}},"text":"Draft answer"}`)
	view := m.streamView()
	for _, want := range []string{"Reasoning", "Compare options", "Choose simple code", "Plan", "Inspect contract", "completed", "in_progress", "Activity", "read_file", "Read contract", "bash", "test output", "Draft answer"} {
		if !strings.Contains(view, want) {
			t.Errorf("missing %q in %s", want, view)
		}
	}
	if strings.Count(view, "test output") != 1 {
		t.Errorf("current/history duplicate: %s", view)
	}
	send(`{"task_id":"t","seq":2,"reasoning":"New reasoning","plan":{"steps":[]},"activity":{},"text":"Replacement"}`)
	view = m.streamView()
	for _, old := range []string{"Compare options", "Inspect contract", "read_file", "bash", "Draft answer"} {
		if strings.Contains(view, old) {
			t.Errorf("stale snapshot %q in %s", old, view)
		}
	}
	if !strings.Contains(view, "New reasoning") {
		t.Fatal(view)
	}
}

func TestRemoteStreamPresentationSafeAndBounded(t *testing.T) {
	m := streamTestModel(t)
	m.textarea.SetWidth(32)
	entry := map[string]any{"id": "a", "name": "bash", "kind": "tool", "status": "failed", "output": strings.Repeat("界", 2000), "error": "bad\x1b[2J\u202eevil"}
	steps := make([]any, 100)
	history := make([]any, 100)
	for i := range steps {
		steps[i] = map[string]string{"step": strings.Repeat("界", 1000), "status": "pending"}
		history[i] = entry
	}
	raw, _ := json.Marshal(map[string]any{"task_id": "t", "seq": 1, "reasoning": strings.Repeat("思考\n", 2000), "text": strings.Repeat("答", 2000), "plan": map[string]any{"steps": steps}, "activity": map[string]any{"history": history, "current": entry}})
	var f remoteStreamFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	m.streamUpdate(remoteStreamEvent{gen: m.gen, id: "t", sub: m.streams["t"], frame: f})
	view := m.streamView()
	if strings.ContainsAny(view, "\x1b\u202e") {
		t.Fatalf("unsafe display: %q", view)
	}
	if len(strings.Split(view, "\n")) > 32 {
		t.Fatal("unbounded rows")
	}
	for _, line := range strings.Split(view, "\n") {
		if ansi.StringWidth(line) > 32 {
			t.Fatalf("unbounded columns: %q", line)
		}
	}
	if !strings.Contains(view, "…") {
		t.Fatal("missing truncation indicator")
	}
}

func TestRemoteStreamPresentationLifecycle(t *testing.T) {
	m := streamTestModel(t)
	s := m.streams["t"]
	var f remoteStreamFrame
	if err := json.Unmarshal([]byte(`{"task_id":"t","seq":2,"reasoning":"live reasoning","plan":{"steps":[{"step":"live plan"}]},"activity":{"current":{"id":"x","name":"live activity","error":"failure detail"}}}`), &f); err != nil {
		t.Fatal(err)
	}
	m.streamUpdate(remoteStreamEvent{gen: m.gen, id: "t", sub: s, frame: f})
	if !strings.Contains(m.streamView(), "failure detail") {
		t.Fatal("activity error missing")
	}
	stale := f
	stale.Seq = 1
	stale.Reasoning = "stale reasoning"
	m.streamUpdate(remoteStreamEvent{gen: m.gen, id: "t", sub: s, frame: stale})
	if strings.Contains(m.streamView(), "stale reasoning") {
		t.Fatal("stale progress accepted")
	}
	m.streamUpdate(remoteStreamEvent{gen: m.gen, id: "t", sub: s, err: fmt.Errorf("offline")})
	for _, old := range []string{"live reasoning", "live plan", "live activity"} {
		if strings.Contains(m.streamView(), old) {
			t.Fatalf("offline stream retained %q", old)
		}
	}
	// HTTP remains authoritative even if a full progress snapshot says done.
	s.retry = time.Now().Add(-time.Second)
	m.syncStreams()
	s = m.streams["t"]
	f.Done = true
	m.streamUpdate(remoteStreamEvent{gen: m.gen, id: "t", sub: s, frame: f})
	if !strings.Contains(m.streamView(), "live reasoning") || !strings.Contains(m.streamView(), "awaiting HTTP result") {
		t.Fatal("final preview lost before HTTP reconciliation")
	}
	m.tasks["t"] = taskdomain.TaskInfo{ID: "t", TopicID: "a", Status: taskdomain.TaskDone}
	m.syncStreams()
	if m.streamView() != "" {
		t.Fatal("HTTP terminal state retained progress")
	}
}

func TestRemoteStreamKeepsComposerVisible(t *testing.T) {
	m := streamTestModel(t)
	m.listing = false
	m.textarea.SetValue("draft-visible")
	s := m.streams["t"]
	s.reasoning = strings.Repeat("reasoning\n", 20)
	s.plan = []string{"1. inspect", "2. implement", "3. test"}
	s.history = []string{"tool one", "tool two", "tool three", "tool four"}
	s.activity = "running tool"
	s.text = strings.Repeat("response\n", 20)
	for _, size := range []tea.WindowSizeMsg{{Width: 40, Height: 12}, {Width: 24, Height: 8}, {Width: 24, Height: 4}} {
		m.Update(size)
		view := m.View().Content
		if !strings.Contains(view, "draft-visible") {
			t.Fatalf("stream hid composer at %dx%d: %s", size.Width, size.Height, view)
		}
		if len(strings.Split(view, "\n")) > size.Height {
			t.Fatal("view exceeds terminal height")
		}
	}
}

package chatcmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pagination"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func remoteTestModel(t *testing.T, h http.HandlerFunc) *chatModel {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := newRemoteClient(srv.URL+"/runtime", "secret")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return newSharedChatModel(ctx, c)
}
func keyRemote(code rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: code} }

func remoteSubmissionResult(t *testing.T, cmd tea.Cmd) remoteWrite {
	t.Helper()
	commands := []tea.Cmd{cmd}
	for len(commands) > 0 {
		command := commands[0]
		commands = commands[1:]
		switch result := command().(type) {
		case tea.BatchMsg:
			commands = append(commands, result...)
		case remoteWrite:
			return result
		}
	}
	t.Fatal("command did not submit to the runtime")
	return remoteWrite{}
}

func TestRemoteStartupCreatesTopicOnFirstMessage(t *testing.T) {
	var submitted []daemonruntime.SubmitTaskRequest
	requests := 0
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/runtime/tasks":
			var task daemonruntime.SubmitTaskRequest
			if err := json.NewDecoder(r.Body).Decode(&task); err != nil {
				t.Error(err)
			}
			submitted = append(submitted, task)
			fmt.Fprint(w, `{"id":"first-task","topic_id":"created","status":"queued"}`)
		case r.URL.Path == "/runtime/topics/created":
			fmt.Fprint(w, `{"id":"created","title":"First conversation"}`)
		case r.URL.Path == "/runtime/workspace":
			fmt.Fprint(w, `{"workspace_dir":"/server/default"}`)
		case r.URL.Path == "/runtime/tasks":
			fmt.Fprint(w, `{"items":[{"id":"first-task","topic_id":"created","task":"hello","status":"done"}]}`)
		default:
			t.Errorf("unexpected startup request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
	m.Init()
	if m.listing || !m.hasChat || m.id != "" || requests != 0 {
		t.Fatal("startup did not open an empty conversation")
	}
	if _, cmd := m.Update(keyRemote(tea.KeyEnter)); cmd != nil {
		t.Fatal("empty input submitted a task")
	}
	m.textarea.SetValue("hello")
	_, send := m.Update(keyRemote(tea.KeyEnter))
	if send == nil {
		t.Fatal("could not send directly from the initial conversation")
	}
	_, load := m.Update(remoteSubmissionResult(t, send))
	if len(submitted) != 1 || submitted[0].Task != "hello" || submitted[0].TopicID != "" || submitted[0].WorkspaceDir != "" {
		t.Fatalf("first message should create a topic using the server workspace default: %+v", submitted)
	}
	if load == nil {
		t.Fatal("created topic was not loaded")
	}
	m.Update(load())
	if m.id != "created" || m.listing || m.tasks["first-task"].Task != "hello" || m.textarea.Value() != "" {
		t.Fatal("first message did not bind the conversation to the shared topic and history")
	}
}

func TestRemoteStartupTopicsCommandReturnsToDraft(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/workspace":
			fmt.Fprint(w, `{"workspace_dir":"/server/default"}`)
		case "/runtime/topics":
			fmt.Fprint(w, `{"items":[{"id":"existing","title":"Existing conversation"}]}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	})
	m.Init()
	m.textarea.SetValue("unsent first message")
	cmd := m.command("/topics")
	if cmd == nil || !m.listing {
		t.Fatal("/topics did not open the topic list")
	}
	m.Update(cmd())
	if len(m.topics) != 1 || m.topics[0].ID != "existing" {
		t.Fatal("/topics did not load existing topics")
	}
	m.Update(keyRemote(tea.KeyEscape))
	if m.listing || !m.hasChat || m.id != "" || m.textarea.Value() != "unsent first message" {
		t.Fatal("Escape did not restore the initial conversation and draft")
	}
}

func TestRemoteStartupKeepsExplicitTopic(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected startup request: %s %s", r.Method, r.URL.Path)
	})
	// runRemoteChat loads --topic before initializing the terminal model.
	m.applyLoaded(remoteLoaded{
		id: "existing", topic: taskdomain.TopicInfo{ID: "existing", Title: "Existing conversation"},
		tasks: []taskdomain.TaskInfo{{ID: "previous", TopicID: "existing", Task: "earlier message", Status: taskdomain.TaskDone}},
	})
	cmd := m.Init()
	if cmd == nil || m.listing || m.id != "existing" || m.tasks["previous"].Task != "earlier message" {
		t.Fatal("initialization replaced the explicit topic or its history")
	}
}

func TestRemoteListKeysAndGeneration(t *testing.T) {
	requests := 0
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch r.URL.Path {
		case "/runtime/topics/b":
			fmt.Fprint(w, `{"id":"b","title":"B"}`)
		case "/runtime/workspace":
			fmt.Fprint(w, `{"workspace_dir":"/repo"}`)
		case "/runtime/tasks":
			fmt.Fprint(w, `{"items":[{"id":"task-b","topic_id":"b","task":"hello","status":"done"}]}`)
		default:
			http.NotFound(w, r)
		}
	})
	m.hasChat = true
	m.id = "a"
	m.textarea.SetValue("draft A")
	m.save()
	m.listing = true
	m.topics = []taskdomain.TopicInfo{{ID: "a"}, {ID: "b"}}
	m.Update(keyRemote(tea.KeyDown))
	if m.id != "a" || m.selected != 1 || requests != 0 {
		t.Fatal("arrow switched or performed IO")
	}
	old := m.gen
	_, cmd := m.Update(keyRemote(tea.KeyEnter))
	if requests != 0 || cmd == nil {
		t.Fatal("Enter blocked on IO")
	}
	m.Update(remoteLoaded{gen: old, id: "late", topic: taskdomain.TopicInfo{ID: "late"}})
	if m.id != "a" {
		t.Fatal("stale response changed topic")
	}
	m.Update(cmd())
	if m.id != "b" || m.listing || m.drafts["a"].text != "draft A" {
		t.Fatalf("switch lost state: %+v", m)
	}
	m.textarea.SetValue("draft B")
	m.save()
	m.listing = true
	m.Update(keyRemote(tea.KeyEscape))
	if m.listing || m.textarea.Value() != "draft B" || m.id != "b" {
		t.Fatal("Esc lost draft")
	}
}
func TestRemoteFailedSwitchAndEmptyEnter(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	m.id = "a"
	m.hasChat = true
	m.textarea.SetValue("keep")
	m.save()
	m.listing = true
	_, cmd := m.Update(keyRemote(tea.KeyEnter))
	if cmd != nil {
		t.Fatal("empty Enter did work")
	}
	m.renew()
	m.Update(m.load("missing", false)())
	if m.id != "a" || m.textarea.Value() != "keep" || !m.listing {
		t.Fatal("failed switch altered view")
	}
}
func TestRemoteSubmissionOwnershipAndWorkspaceSnapshot(t *testing.T) {
	var submitted daemonruntime.SubmitTaskRequest
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/runtime/tasks" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&submitted)
		fmt.Fprint(w, `{"id":"task-new","topic_id":"created","status":"queued"}`)
	})
	m.hasChat = true
	m.draft().workspace = "/server/repo"
	m.textarea.SetValue("first")
	cmd := m.submit("first")
	if m.submit("duplicate") != nil {
		t.Fatal("allowed duplicate draft creation")
	}
	m.textarea.SetValue("later edit")
	m.save()
	m.draft().workspace = "/changed"
	m.id = "other"
	m.textarea.SetValue("other text")
	m.save()
	m.renew()
	m.Update(cmd())
	if submitted.WorkspaceDir != "/server/repo" || submitted.TopicID != "" || submitted.Task != "first" {
		t.Fatalf("submission: %+v", submitted)
	}
	if m.id != "other" || m.textarea.Value() != "other text" || m.drafts["created"].text != "later edit" {
		t.Fatal("late submission hijacked view or erased edits")
	}
}
func TestRemoteUnknownSubmissionIsNotRetried(t *testing.T) {
	count := 0
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { count++; fmt.Fprint(w, `{`) })
	m.textarea.SetValue("hello")
	cmd := m.submit("hello")
	m.Update(cmd())
	if !m.drafts[""].unknown {
		t.Fatal("missing unknown state")
	}
	if m.submit("hello") != nil || count != 1 {
		t.Fatal("retried unknown submission")
	}
}
func TestRemoteRefreshCrossesPagesAndTracksPending(t *testing.T) {
	pages := 0
	tracked := 0
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/topics/a":
			fmt.Fprint(w, `{"id":"a","title":"updated"}`)
		case "/runtime/workspace":
			fmt.Fprint(w, `{"workspace_dir":"/changed"}`)
		case "/runtime/tasks":
			pages++
			if r.URL.Query().Get("cursor") == "" {
				fmt.Fprint(w, `{"items":[{"id":"new-2"}],"has_next":true,"next_cursor":"next"}`)
			} else {
				fmt.Fprint(w, `{"items":[{"id":"new-1"},{"id":"known"}]}`)
			}
		case "/runtime/tasks/pending":
			tracked++
			fmt.Fprint(w, `{"id":"pending","status":"done"}`)
		default:
			http.NotFound(w, r)
		}
	})
	m.id = "a"
	m.hasChat = true
	m.textarea.SetValue("unsent")
	m.tasks = map[string]taskdomain.TaskInfo{"known": {ID: "known", Status: taskdomain.TaskDone}, "old": {ID: "old", Status: taskdomain.TaskDone}, "pending": {ID: "pending", Status: taskdomain.TaskPending}}
	m.cursor = "older"
	m.Update(m.load("a", true)())
	if pages != 2 || tracked != 1 || len(m.tasks) != 5 || m.cursor != "older" || m.textarea.Value() != "unsent" || m.dir != "/changed" {
		t.Fatalf("refresh: pages=%d tracked=%d tasks=%v", pages, tracked, m.tasks)
	}
	if m.tasks["pending"].Status != taskdomain.TaskDone {
		t.Fatal("pending not tracked")
	}
	_, cmd := m.Update(remoteTick{m.gen, m.tickSeq})
	if cmd == nil {
		t.Fatal("terminal task stopped topic polling")
	}
}
func TestRemoteDeleteConfirmationAndLateResult(t *testing.T) {
	deletes := 0
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" && r.URL.Path == "/runtime/topics/a" {
			deletes++
			w.WriteHeader(204)
			return
		}
		t.Errorf("unexpected request")
	})
	m.id = "a"
	m.command("/topic delete")
	if deletes != 0 {
		t.Fatal("deleted before confirmation")
	}
	m.Update(tea.KeyPressMsg{Code: 'n', Text: "n"})
	if deletes != 0 {
		t.Fatal("deleted on n")
	}
	m.command("/topic delete")
	_, cmd := m.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	m.id = "b"
	m.Update(cmd())
	if deletes != 1 || m.id != "b" || m.listing {
		t.Fatal("late delete hijacked current topic")
	}
}
func TestRemoteHistorySteering(t *testing.T) {
	now := time.Now()
	tasks := map[string]taskdomain.TaskInfo{"steer": {ID: "steer", Task: "more", CreatedAt: now.Add(time.Second), SteerTargetTaskID: "target", Status: taskdomain.TaskDone}}
	rows := remoteHistory(tasks)
	if len(rows) != 2 || rows[1].role != "system" {
		t.Fatal("invented target answer")
	}
	tasks["target"] = taskdomain.TaskInfo{ID: "target", Task: "first", CreatedAt: now, Status: taskdomain.TaskDone, Result: map[string]any{"final": map[string]any{"output": "answer"}}}
	rows = remoteHistory(tasks)
	if len(rows) != 4 || rows[1].id != "steer:user" || rows[2].id != "target:assistant" || !strings.Contains(rows[2].text, "answer") {
		t.Fatalf("projection: %+v", rows)
	}
}
func TestRemoteListFailureDoesNotBecomeEmpty(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "fail", 500) })
	m.listing = true
	m.topics = []taskdomain.TopicInfo{{ID: "keep"}}
	m.scope = "/repo"
	m.Update(remoteListed{gen: m.gen, err: &remoteHTTPError{500}})
	if len(m.topics) != 1 || !strings.Contains(m.notice, "500") {
		t.Fatal("failure hidden as empty")
	}
	m.Update(remoteListed{gen: m.gen - 1, dir: "/wrong", page: pagination.Page[taskdomain.TopicInfo]{Items: []taskdomain.TopicInfo{{ID: "wrong"}}}})
	if m.scope != "/repo" {
		t.Fatal("late directory result applied")
	}
}

func TestRemoteDraftPromotionDoesNotReattachWorkspace(t *testing.T) {
	var submitted daemonruntime.SubmitTaskRequest
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
			t.Error(err)
		}
		fmt.Fprint(w, `{"id":"next","topic_id":"created"}`)
	})
	m.id = "created"
	m.drafts["created"] = &remoteDraft{workspace: "/outdated"}
	m.textarea.SetValue("continue")
	m.submit("continue")()
	if submitted.WorkspaceDir != "" {
		t.Fatal("existing topic submission overwrote server attachment")
	}
}

func TestRemotePollingSurvivesBusyHistoryAndFailure(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {})
	m.id = "a"
	m.loading = true
	_, cmd := m.Update(remoteTick{m.gen, m.tickSeq})
	if cmd == nil {
		t.Fatal("busy history lost polling wakeup")
	}
	_, cmd = m.Update(remoteOlder{gen: m.gen, err: &remoteHTTPError{503}})
	if cmd == nil || m.loading {
		t.Fatal("failed history page lost polling")
	}
}

func TestRemoteExternalDeletionRetainsDraftAndNetworkIsNotDeletion(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {})
	m.id = "a"
	m.textarea.SetValue("keep")
	m.Update(remoteLoaded{gen: m.gen, id: "a", refresh: true, err: &remoteHTTPError{503}})
	if m.deleted {
		t.Fatal("network failure treated as deletion")
	}
	m.Update(remoteLoaded{gen: m.gen, id: "a", refresh: true, deleted: true, err: &remoteHTTPError{404}})
	if !m.deleted || m.textarea.Value() != "keep" || m.submit("no") != nil {
		t.Fatal("deleted topic accepts send or lost draft")
	}
}

func TestRemoteListRefreshKeepsScopeAndSelection(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/runtime/workspace" {
			fmt.Fprint(w, `{"workspace_dir":"/fixed"}`)
			return
		}
		fmt.Fprint(w, `{"items":[{"id":"b"},{"id":"a"}]}`)
	})
	m.listing = true
	m.scopeReady = true
	m.scope = "/fixed"
	m.dir = "/changed"
	m.topics = []taskdomain.TopicInfo{{ID: "a"}, {ID: "b"}}
	m.selected = 1
	_, refresh := m.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	if refresh == nil {
		t.Fatal("Ctrl+R did not refresh topics")
	}
	m.Update(refresh())
	if m.scope != "/fixed" || m.matches()[m.selected].ID != "b" {
		t.Fatal("refresh changed scope or selection")
	}
	m.filter = "absent"
	_, cmd := m.Update(keyRemote(tea.KeyEnter))
	if cmd != nil {
		t.Fatal("filter miss entered hidden topic")
	}
}

func TestRemoteExitAndStopOwnership(t *testing.T) {
	hits := 0
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Method != "POST" || r.URL.Path != "/runtime/topics/b/stop" {
			t.Errorf("wrong stop: %s %s", r.Method, r.URL)
		}
		fmt.Fprint(w, `{}`)
	})
	m.id = "b"
	if m.command("/exit")() != tea.Quit() || hits != 0 {
		t.Fatal("exit sent a request")
	}
	m.command("/stop")()
	if hits != 1 {
		t.Fatal("stop not explicit")
	}
}

func TestRemoteDisplayRejectsTerminalControls(t *testing.T) {
	if got := remoteDisplay("hello\x1b[2J\x1b]52;c;secret\a world"); got != "hello world" {
		t.Fatalf("unsafe output: %q", got)
	}
}

func TestRemoteFlagsRejectLocalOverridesBeforeSession(t *testing.T) {
	for _, args := range [][]string{{"--standalone", "--topic", "a"}, {"--runtime-url", ""}, {"--runtime-url", "http://localhost/runtime", "--workspace", "/local"}, {"--runtime-url", "http://localhost/runtime", "--model", "local"}} {
		cmd := New(Dependencies{})
		cmd.SetArgs(args)
		if err := cmd.Execute(); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestRemoteListPasteDoesNotEditChatDraft(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {})
	m.textarea.SetValue("draft")
	m.save()
	m.listing = true
	m.Update(tea.PasteMsg{Content: "search"})
	if m.filter != "search" || m.textarea.Value() != "draft" || m.draft().text != "draft" {
		t.Fatal("list paste escaped focus")
	}
}

func TestRemoteTitleConflictAndWorkspaceWire(t *testing.T) {
	methods := []string{}
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/runtime/topics/a/regenerate-title":
			w.WriteHeader(http.StatusConflict)
		case "/runtime/workspace":
			if r.Method == "PUT" {
				var body map[string]string
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["topic_id"] != "a" || body["workspace_dir"] != "/server/repo" {
					t.Errorf("body: %v", body)
				}
			} else if r.Method != "DELETE" || r.URL.Query().Get("topic_id") != "a" {
				t.Errorf("wrong detach: %s", r.URL)
			}
			fmt.Fprint(w, `{}`)
		default:
			t.Errorf("unexpected request: %s", r.URL)
		}
	})
	m.id = "a"
	m.Update(m.command("/topic title regenerate")())
	if !strings.Contains(m.notice, "conflict") {
		t.Fatal("title conflict hidden")
	}
	m.command("/workspace attach /server/repo")()
	m.command("/workspace detach")()
	if len(methods) != 3 {
		t.Fatalf("requests: %v", methods)
	}
}

func TestRemoteSelectableActions(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"items":[]}`) })
	m.listing = true
	if strings.Contains(m.View().Content, "> New topic") {
		t.Fatal("action before scope resolution")
	}
	m.scopeReady, m.scope, m.listCursor = true, "/server/repo", "next"
	m.topics = []taskdomain.TopicInfo{{ID: "hidden", Title: "hidden"}}
	m.filter = "absent"
	if v := m.View().Content; !strings.Contains(v, "> New topic") || !strings.Contains(v, "Load more") {
		t.Fatalf("missing explicit actions: %s", v)
	}
	m.Update(keyRemote(tea.KeyDown))
	_, cmd := m.Update(keyRemote(tea.KeyEnter))
	if cmd == nil || !m.loading || !m.listing {
		t.Fatal("Enter did not load more")
	}
	m.Update(cmd())
	m.selected = 0
	m.Update(keyRemote(tea.KeyEnter))
	if m.listing || m.id != "" || m.draft().workspace != "/server/repo" {
		t.Fatal("new row did not create scoped draft")
	}
}

func TestRemoteNarrowLayout(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {})
	m.scopeReady = true
	m.scope = strings.Repeat("/非常に長い道", 20)
	m.dir = m.scope
	m.notice = strings.Repeat("status ", 50)
	for i := 0; i < 40; i++ {
		m.topics = append(m.topics, taskdomain.TopicInfo{ID: fmt.Sprint(i), Title: strings.Repeat("界", 100)})
	}
	for _, listing := range []bool{true, false} {
		m.listing = listing
		for _, size := range []tea.WindowSizeMsg{{Width: 32, Height: 12}, {Width: 8, Height: 4}, {Width: 1, Height: 1}} {
			m.Update(size)
			m.selected = 39
			lines := strings.Split(m.View().Content, "\n")
			if len(lines) > size.Height {
				t.Fatalf("height %d exceeds %d", len(lines), size.Height)
			}
			for _, line := range lines {
				if ansi.StringWidth(line) > size.Width {
					t.Fatalf("width exceeds %d: %q", size.Width, line)
				}
			}
		}
	}
}

func TestRemoteNewDraftResetsHistoryCursor(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {})
	m.cursor = "old-topic-page"
	m.newDraft()
	if m.cursor != "" {
		t.Fatal("new draft retained another topic's history cursor")
	}
}

func TestRemoteListCtrlCPreservesChatDraft(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {})
	m.textarea.SetValue("unsent chat")
	m.save()
	m.listing, m.filter = true, "filter"
	m.Update(tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl})
	if m.textarea.Value() != "unsent chat" || m.filter != "" {
		t.Fatal("list Ctrl+C edited hidden chat draft")
	}
}

func TestRemoteActionAndTopicSelectionAcrossPages(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {})
	m.listing, m.scopeReady = true, true
	m.topics = []taskdomain.TopicInfo{{ID: "a"}, {ID: "b"}}
	m.selected = 1
	m.Update(remoteListed{gen: m.gen, more: true, page: pagination.Page[taskdomain.TopicInfo]{Items: []taskdomain.TopicInfo{{ID: "z"}}, NextCursor: "next"}})
	if m.listRows()[m.selected].id != "b" {
		t.Fatal("page changed selected topic")
	}
	m.selected = len(m.matches())
	m.Update(remoteListed{gen: m.gen, page: pagination.Page[taskdomain.TopicInfo]{Items: []taskdomain.TopicInfo{{ID: "x"}}}})
	if m.listRows()[m.selected].action != "new" {
		t.Fatal("refresh changed selected action")
	}
	m.filter = "missing"
	m.selected = 0
	m.Update(keyRemote(tea.KeyEnter))
	if m.id != "" || m.listing {
		t.Fatal("filtered Enter did not activate explicit New topic row")
	}
}

func TestRemoteListStatusKeepsFullWorkspace(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {})
	m.listing, m.scopeReady = true, true
	m.scope = "/server/" + strings.Repeat("long-directory/", 20)
	m.Update(tea.WindowSizeMsg{Width: 20, Height: 8})
	_, cmd := m.Update(tea.KeyPressMsg{Code: 's', Mod: tea.ModCtrl})
	if cmd == nil || !strings.Contains(strings.Join(m.transcriptQueue, "\n"), m.scope) {
		t.Fatal("full list workspace unavailable through status")
	}
}

func TestRemoteDraftStatusSanitizesServerPath(t *testing.T) {
	m := remoteTestModel(t, func(http.ResponseWriter, *http.Request) {})
	m.dir = "/server/\x1b[2Jworkspace"
	cmd := m.command("/status")
	if cmd == nil {
		t.Fatal("missing status output")
	}
	if output := strings.Join(m.transcriptQueue, "\n"); strings.Contains(output, "\x1b") {
		t.Fatalf("draft status emitted terminal escape: %q", output)
	}
}

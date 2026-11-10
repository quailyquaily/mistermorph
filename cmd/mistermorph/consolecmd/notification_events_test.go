package consolecmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func newTestCompletionHub(clock *fakeClock) *consoleNotificationHub {
	hub := newConsoleNotificationHub()
	hub.completions = newTaskCompletionLog(clock.now)
	return hub
}

func runTask(hub *consoleNotificationHub, id, topic string, status daemonruntime.TaskStatus, trigger daemonruntime.TaskTrigger) {
	queued := daemonruntime.TaskInfo{ID: id, TopicID: topic, Status: daemonruntime.TaskQueued}
	hub.PublishTaskCompletion(daemonruntime.TaskInfo{}, queued, trigger)
	running := queued
	running.Status = daemonruntime.TaskRunning
	hub.PublishTaskCompletion(queued, running, trigger)
	done := running
	done.Status = status
	hub.PublishTaskCompletion(running, done, trigger)
}

func eventIDs(page taskCompletionPage) []string {
	out := []string{}
	for _, event := range page.Events {
		out = append(out, event.ID)
	}
	return out
}

func sameIDs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// A watcher that was away reads the completions since it left, then those after its cursor; a
// cursor of an earlier server start falls back to the time it has been away.
func TestTaskCompletionLogReadsSinceAndAfterCursor(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	hub := newTestCompletionHub(clock)
	runTask(hub, "old", "topic-1", daemonruntime.TaskDone, chatTrigger)
	clock.t = clock.t.Add(10 * time.Minute)
	runTask(hub, "recent", "topic-1", daemonruntime.TaskFailed, chatTrigger)
	clock.t = clock.t.Add(time.Minute)

	page, _ := hub.completions.read(taskCompletionQuery{after: -1, since: 2 * time.Minute})
	if !sameIDs(eventIDs(page), []string{"topic-task:recent"}) || page.Events[0].Status != "failed" || page.Events[0].TopicID != "topic-1" {
		t.Fatalf("since read = %#v", page)
	}
	if page.Cursor != 2 || page.Epoch == "" || page.Active != 0 {
		t.Fatalf("page = %#v", page)
	}

	none, _ := hub.completions.read(taskCompletionQuery{after: -1})
	if len(none.Events) != 0 || none.Cursor != 2 {
		t.Fatalf("a read without since or cursor returned %#v", none)
	}

	runTask(hub, "next", "topic-2", daemonruntime.TaskDone, chatTrigger)
	after, _ := hub.completions.read(taskCompletionQuery{epoch: page.Epoch, after: page.Cursor})
	if !sameIDs(eventIDs(after), []string{"topic-task:next"}) || after.Cursor != 3 {
		t.Fatalf("after read = %#v", after)
	}

	restarted, _ := hub.completions.read(taskCompletionQuery{epoch: "earlier-start", after: 1, since: 30 * time.Second})
	if !sameIDs(eventIDs(restarted), []string{"topic-task:next"}) {
		t.Fatalf("a cursor of another start must fall back to since: %#v", restarted)
	}
	ahead, _ := hub.completions.read(taskCompletionQuery{epoch: page.Epoch, after: 99, since: 30 * time.Second})
	if !sameIDs(eventIDs(ahead), []string{"topic-task:next"}) {
		t.Fatalf("a cursor past the log must fall back to since: %#v", ahead)
	}
}

// Only the person's own chat completions are kept: never a TODO item's run (scheduled or manual,
// which notify through the item's opt-in), Awareness, Agent Link or a steer.
func TestTaskCompletionLogKeepsOnlyChatCompletions(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	hub := newTestCompletionHub(clock)
	runTask(hub, "scheduled", "topic-1", daemonruntime.TaskDone, scheduledCronTrigger)
	runTask(hub, "manual", "topic-1", daemonruntime.TaskDone, manualCronTrigger)
	runTask(hub, "awareness", daemonruntime.ConsoleAwarenessTopicID, daemonruntime.TaskDone, chatTrigger)
	runTask(hub, "chat", "topic-1", daemonruntime.TaskDone, chatTrigger)
	steer := daemonruntime.TaskInfo{ID: "steer", TopicID: "topic-1", Status: daemonruntime.TaskRunning, SteerTargetTaskID: "chat"}
	done := steer
	done.Status = daemonruntime.TaskDone
	hub.PublishTaskCompletion(steer, done, chatTrigger)

	page, _ := hub.completions.read(taskCompletionQuery{after: -1, since: time.Hour})
	if !sameIDs(eventIDs(page), []string{"topic-task:chat"}) {
		t.Fatalf("kept %v", eventIDs(page))
	}
}

// Active counts the person's chat tasks that are queued or running, so a watcher knows whether
// anything is left to wait for.
func TestTaskCompletionLogCountsActiveChatTasks(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	hub := newTestCompletionHub(clock)
	queued := daemonruntime.TaskInfo{ID: "a", TopicID: "topic-1", Status: daemonruntime.TaskQueued}
	hub.PublishTaskCompletion(daemonruntime.TaskInfo{}, queued, chatTrigger)
	hub.PublishTaskCompletion(daemonruntime.TaskInfo{}, daemonruntime.TaskInfo{ID: "cron", TopicID: "topic-1", Status: daemonruntime.TaskRunning}, scheduledCronTrigger)
	running := daemonruntime.TaskInfo{ID: "b", TopicID: "topic-2", Status: daemonruntime.TaskRunning}
	hub.PublishTaskCompletion(daemonruntime.TaskInfo{}, running, chatTrigger)
	if page, _ := hub.completions.read(taskCompletionQuery{after: -1}); page.Active != 2 {
		t.Fatalf("active = %d, want 2", page.Active)
	}
	done := running
	done.Status = daemonruntime.TaskDone
	hub.PublishTaskCompletion(running, done, chatTrigger)
	canceled := queued
	canceled.Status = daemonruntime.TaskCanceled
	hub.PublishTaskCompletion(queued, canceled, chatTrigger)
	if page, _ := hub.completions.read(taskCompletionQuery{after: -1}); page.Active != 0 {
		t.Fatalf("active = %d, want 0", page.Active)
	}
}

func TestTaskCompletionLogDropsOldAndExcessEntries(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	hub := newTestCompletionHub(clock)
	runTask(hub, "stale", "topic-1", daemonruntime.TaskDone, chatTrigger)
	clock.t = clock.t.Add(taskCompletionLogAge + time.Minute)
	for i := 0; i < taskCompletionLogLimit+5; i++ {
		runTask(hub, "t"+strconv.Itoa(i), "topic-1", daemonruntime.TaskDone, chatTrigger)
	}
	page, _ := hub.completions.read(taskCompletionQuery{epoch: hub.completions.epoch, after: 0})
	if len(page.Events) != taskCompletionLogLimit || page.Events[0].ID != "topic-task:t5" {
		t.Fatalf("kept %d events, first %v", len(page.Events), page.Events[0].ID)
	}
}

func newEventsServer(t *testing.T, hub *consoleNotificationHub) (*httptest.Server, string) {
	t.Helper()
	srv := &server{cfg: serveConfig{password: "test-password"}, sessions: newSessionStore(""), localRuntime: &consoleLocalRuntime{notificationHub: hub}}
	token, _, err := srv.sessions.Create(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(srv.withAuth(srv.handleNotificationEvents))
	t.Cleanup(httpServer.Close)
	return httpServer, token
}

func getEvents(t *testing.T, url, token string) (int, taskCompletionPage) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var page taskCompletionPage
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode, page
}

func TestNotificationEventsNeedsASession(t *testing.T) {
	httpServer, _ := newEventsServer(t, newConsoleNotificationHub())
	if status, _ := getEvents(t, httpServer.URL, ""); status != http.StatusUnauthorized {
		t.Fatalf("status without a token = %d", status)
	}
	if status, _ := getEvents(t, httpServer.URL, "stale-token"); status != http.StatusUnauthorized {
		t.Fatalf("status with an unknown token = %d", status)
	}
}

func TestNotificationEventsRejectsBadQueries(t *testing.T) {
	httpServer, token := newEventsServer(t, newConsoleNotificationHub())
	for _, query := range []string{"?after=-1", "?after=x", "?since_ms=-5", "?wait=soon"} {
		if status, _ := getEvents(t, httpServer.URL+query, token); status != http.StatusBadRequest {
			t.Fatalf("%s: status = %d", query, status)
		}
	}
}

// A waiting request answers as soon as a completion comes, with only that completion; the
// frame holds identifiers and status alone.
func TestNotificationEventsWaitsForTheNextCompletion(t *testing.T) {
	hub := newConsoleNotificationHub()
	runTask(hub, "earlier", "topic-1", daemonruntime.TaskDone, chatTrigger)
	httpServer, token := newEventsServer(t, hub)
	_, first := getEvents(t, httpServer.URL+"?since_ms=60000", token)
	if !sameIDs(eventIDs(first), []string{"topic-task:earlier"}) {
		t.Fatalf("first read = %#v", first)
	}

	go func() {
		time.Sleep(100 * time.Millisecond)
		runTask(hub, "later", "topic-2", daemonruntime.TaskFailed, chatTrigger)
	}()
	started := time.Now()
	status, page := getEvents(t, httpServer.URL+"?wait=10&epoch="+first.Epoch+"&after="+strconv.FormatInt(first.Cursor, 10), token)
	if status != http.StatusOK || !sameIDs(eventIDs(page), []string{"topic-task:later"}) || page.Events[0].Status != "failed" {
		t.Fatalf("waited read = %d %#v", status, page)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("the waiting request did not answer at the completion")
	}
	raw, err := json.Marshal(page.Events[0])
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 4 {
		t.Fatalf("completion frame carries more than identifiers and status: %s", raw)
	}
}

// A request that waits through a scheduled TODO run's completion still answers with nothing.
func TestNotificationEventsWaitSkipsScheduledRuns(t *testing.T) {
	hub := newConsoleNotificationHub()
	httpServer, token := newEventsServer(t, hub)
	go func() {
		time.Sleep(100 * time.Millisecond)
		runTask(hub, "scheduled", "topic-1", daemonruntime.TaskDone, scheduledCronTrigger)
	}()
	status, page := getEvents(t, httpServer.URL+"?wait=1&since_ms=60000", token)
	if status != http.StatusOK || len(page.Events) != 0 {
		t.Fatalf("read = %d %#v", status, page)
	}
}

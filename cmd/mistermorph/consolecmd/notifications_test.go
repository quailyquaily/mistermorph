package consolecmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	awarenessloop "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

func TestConsoleNotificationHubPublishesToSubscribers(t *testing.T) {
	hub := newConsoleNotificationHub()
	events, unsubscribe := hub.Subscribe()
	defer unsubscribe()

	hub.Publish(awarenessloop.CronNotification{
		ID:    "run-1",
		Title: "Daily review",
		Body:  "Review complete.",
	})

	select {
	case got := <-events:
		if got.ID != "run-1" || got.Title != "Daily review" || got.Body != "Review complete." {
			t.Fatalf("unexpected notification frame: %#v", got)
		}
		raw, err := json.Marshal(got)
		if err != nil {
			t.Fatalf("marshal notification: %v", err)
		}
		var fields map[string]any
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatalf("unmarshal notification fields: %v", err)
		}
		if len(fields) != 3 {
			t.Fatalf("notification fields = %#v, want id, title, body", fields)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for notification")
	}
}

var (
	scheduledCronTrigger = daemonruntime.TaskTrigger{Source: "console", Event: daemonruntime.CronRunTriggerEvent, Ref: daemonruntime.CronRunTriggerRefSchedule, TraceID: "run"}
	manualCronTrigger    = daemonruntime.TaskTrigger{Source: "console", Event: daemonruntime.CronRunTriggerEvent, Ref: daemonruntime.CronRunTriggerRefManual, TraceID: "run"}
	chatTrigger          = daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: "web/console"}
)

// A TODO item's opt-in notification is raised for a run a person asked for, never for one its
// schedule fired, whether that run succeeded or failed.
func TestConsoleNotificationHubDropsScheduledCronNotifications(t *testing.T) {
	hub := newConsoleNotificationHub()
	events, unsubscribe := hub.Subscribe()
	defer unsubscribe()

	hub.Publish(awarenessloop.CronNotification{ID: "run-scheduled", Title: "Daily review", Body: "Review complete.", Trigger: awarenessloop.CronNotificationTriggerSchedule})
	hub.Publish(awarenessloop.CronNotification{ID: "run-scheduled-failed", Title: "Daily review", Body: "route unavailable", Trigger: " " + awarenessloop.CronNotificationTriggerSchedule + " "})
	select {
	case got := <-events:
		t.Fatalf("scheduled run notified: %#v", got)
	default:
	}

	hub.Publish(awarenessloop.CronNotification{ID: "run-manual", Title: "Daily review", Body: "Review complete."})
	select {
	case got := <-events:
		if got.ID != "run-manual" {
			t.Fatalf("unexpected notification: %#v", got)
		}
		raw, _ := json.Marshal(got)
		if strings.Contains(string(raw), "trigger") {
			t.Fatalf("manual frame carries a trigger: %s", raw)
		}
	default:
		t.Fatal("manual run did not notify")
	}
}

// Scheduled runs, manual TODO runs and other tasks finishing side by side in a TODO item's topic:
// only the tasks that are not the item's runs notify, once each, however often a finished task is
// written again.
func TestTopicTaskCompletionWithMixedRunsInOneTopic(t *testing.T) {
	hub := newConsoleNotificationHub()
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{OnTaskUpdate: hub.PublishTaskCompletion})
	if err != nil {
		t.Fatal(err)
	}
	events, unsubscribe := hub.Subscribe()
	defer unsubscribe()
	topicID := daemonruntime.CronTopicID("todo")
	runs := []struct {
		id      string
		trigger daemonruntime.TaskTrigger
		status  daemonruntime.TaskStatus
	}{
		{"scheduled-done", scheduledCronTrigger, daemonruntime.TaskDone},
		{"chat-done", chatTrigger, daemonruntime.TaskDone},
		{"scheduled-failed", scheduledCronTrigger, daemonruntime.TaskFailed},
		{"manual-cron", manualCronTrigger, daemonruntime.TaskDone},
		{"chat-failed", chatTrigger, daemonruntime.TaskFailed},
		{"legacy", daemonruntime.TaskTrigger{}, daemonruntime.TaskDone},
	}
	for _, run := range runs {
		info := daemonruntime.TaskInfo{ID: run.id, TopicID: topicID, Status: daemonruntime.TaskRunning}
		if err := store.UpsertWithTrigger(info, run.trigger, ""); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if err := store.Update(run.id, func(task *daemonruntime.TaskInfo) { task.Status = run.status }); err != nil {
				t.Fatal(err)
			}
		}
	}
	var got []string
	for {
		select {
		case event := <-events:
			got = append(got, event.ID+"="+event.Status)
			continue
		default:
		}
		break
	}
	want := []string{"topic-task:chat-done=done", "topic-task:chat-failed=failed", "topic-task:legacy=done"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("notifications = %v, want %v", got, want)
	}
}

func TestConsoleNotificationHubDropsEventsWithoutSubscribers(t *testing.T) {
	hub := newConsoleNotificationHub()
	hub.Publish(awarenessloop.CronNotification{ID: "run-1", Title: "Task"})

	events, unsubscribe := hub.Subscribe()
	defer unsubscribe()

	select {
	case got := <-events:
		t.Fatalf("received stale notification: %#v", got)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestNotificationWebSocketDeliversCronEvent(t *testing.T) {
	hub := newConsoleNotificationHub()
	srv := &server{
		streamTickets: newSessionStore(""),
		localRuntime:  &consoleLocalRuntime{notificationHub: hub},
	}
	ticket, _, err := srv.streamTickets.Create(time.Minute)
	if err != nil {
		t.Fatalf("create ticket: %v", err)
	}

	httpServer := httptest.NewServer(http.HandlerFunc(srv.handleNotificationWebSocket))
	defer httpServer.Close()
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "?ticket=" + ticket
	header := http.Header{"Origin": []string{httpServer.URL}}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("dial notification websocket: %v", err)
	}
	defer conn.Close()

	hub.Publish(awarenessloop.CronNotification{
		ID:    "run-ws",
		Title: "WebSocket task",
		Body:  "Delivered.",
	})
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var got map[string]any
	if err := conn.ReadJSON(&got); err != nil {
		t.Fatalf("read notification websocket: %v", err)
	}
	if len(got) != 3 || got["id"] != "run-ws" || got["title"] != "WebSocket task" || got["body"] != "Delivered." {
		t.Fatalf("unexpected notification frame: %#v", got)
	}
}

func TestTopicTaskCompletionNotifications(t *testing.T) {
	for _, status := range []daemonruntime.TaskStatus{daemonruntime.TaskDone, daemonruntime.TaskFailed} {
		t.Run(string(status), func(t *testing.T) {
			hub := newConsoleNotificationHub()
			store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{
				OnTaskUpdate: hub.PublishTaskCompletion,
			})
			if err != nil {
				t.Fatal(err)
			}
			events, unsubscribe := hub.Subscribe()
			defer unsubscribe()
			info := daemonruntime.TaskInfo{ID: "task-1", TopicID: "topic-1", Status: daemonruntime.TaskRunning, Task: "private input"}
			if err := store.Upsert(info); err != nil {
				t.Fatal(err)
			}
			if err := store.Update(info.ID, func(task *daemonruntime.TaskInfo) {
				task.Status = status
				task.Error = "private error"
				task.Result = map[string]any{"output": "private output"}
			}); err != nil {
				t.Fatal(err)
			}
			select {
			case event := <-events:
				raw, err := json.Marshal(event)
				if err != nil {
					t.Fatal(err)
				}
				var fields map[string]any
				if err := json.Unmarshal(raw, &fields); err != nil {
					t.Fatal(err)
				}
				if len(fields) != 4 || fields["type"] != "topic_task_completed" || fields["id"] != "topic-task:task-1" || fields["topic_id"] != "topic-1" || fields["status"] != string(status) {
					t.Fatalf("unexpected completion frame: %s", raw)
				}
			default:
				t.Fatal("missing live completion")
			}
			if err := store.Update(info.ID, func(task *daemonruntime.TaskInfo) { task.Status = status }); err != nil {
				t.Fatal(err)
			}
			select {
			case event := <-events:
				t.Fatalf("repeated terminal update emitted %#v", event)
			default:
			}
		})
	}
}

func TestTopicTaskCompletionIgnoresNonTransitions(t *testing.T) {
	for _, tc := range []struct {
		name     string
		previous daemonruntime.TaskInfo
		next     daemonruntime.TaskInfo
		trigger  daemonruntime.TaskTrigger
	}{
		{"empty", daemonruntime.TaskInfo{}, daemonruntime.TaskInfo{}, daemonruntime.TaskTrigger{}},
		{"historical", daemonruntime.TaskInfo{}, daemonruntime.TaskInfo{ID: "task", TopicID: "topic", Status: daemonruntime.TaskDone}, daemonruntime.TaskTrigger{}},
		{"repeated", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskDone}, daemonruntime.TaskInfo{ID: "task", TopicID: "topic", Status: daemonruntime.TaskDone}, daemonruntime.TaskTrigger{}},
		{"running", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskQueued}, daemonruntime.TaskInfo{ID: "task", TopicID: "topic", Status: daemonruntime.TaskRunning}, daemonruntime.TaskTrigger{}},
		{"canceled", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: "topic", Status: daemonruntime.TaskCanceled}, daemonruntime.TaskTrigger{}},
		{"no topic", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskFailed}, daemonruntime.TaskTrigger{}},
		{"scheduled cron done", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: daemonruntime.CronTopicID("todo"), Status: daemonruntime.TaskDone}, scheduledCronTrigger},
		{"scheduled cron failed", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: daemonruntime.CronTopicID("todo"), Status: daemonruntime.TaskFailed}, scheduledCronTrigger},
		// The trigger, not the topic, makes a run a TODO item's.
		{"scheduled cron in another topic", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: "topic", Status: daemonruntime.TaskDone}, scheduledCronTrigger},
		// A run a person asked for keeps the item's own opt-in notification instead.
		{"manual cron", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: daemonruntime.CronTopicID("todo"), Status: daemonruntime.TaskDone}, manualCronTrigger},
		{"legacy cron", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: daemonruntime.CronTopicID("todo"), Status: daemonruntime.TaskDone}, daemonruntime.TaskTrigger{Source: "console", Event: daemonruntime.CronRunTriggerEvent}},
		{"heartbeat", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: daemonruntime.ConsoleAwarenessTopicID, Status: daemonruntime.TaskDone}, daemonruntime.TaskTrigger{}},
		{"agent link", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: daemonruntime.AgentLinkTopicID("inst_b"), Status: daemonruntime.TaskFailed}, daemonruntime.TaskTrigger{}},
		{"steering", daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "task", TopicID: "topic", Status: daemonruntime.TaskDone, SteerTargetTaskID: "parent"}, daemonruntime.TaskTrigger{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hub := newConsoleNotificationHub()
			events, unsubscribe := hub.Subscribe()
			defer unsubscribe()
			hub.PublishTaskCompletion(tc.previous, tc.next, tc.trigger)
			select {
			case event := <-events:
				t.Fatalf("unexpected notification: %#v", event)
			default:
			}
		})
	}
}

// The default topic is reserved by the runtime too, but it holds the person's own chats.
func TestTopicTaskCompletionNotifiesInTheDefaultTopic(t *testing.T) {
	hub := newConsoleNotificationHub()
	events, unsubscribe := hub.Subscribe()
	defer unsubscribe()
	hub.PublishTaskCompletion(
		daemonruntime.TaskInfo{ID: "task", Status: daemonruntime.TaskRunning},
		daemonruntime.TaskInfo{ID: "task", TopicID: daemonruntime.ConsoleDefaultTopicID, Status: daemonruntime.TaskDone},
		chatTrigger,
	)
	select {
	case event := <-events:
		if event.Type != "topic_task_completed" || event.TopicID != daemonruntime.ConsoleDefaultTopicID {
			t.Fatalf("unexpected event: %#v", event)
		}
	default:
		t.Fatal("no notification for a task in the default topic")
	}
}

func TestTopicNotificationWebSocketDoesNotReplayOnReconnect(t *testing.T) {
	hub := newConsoleNotificationHub()
	srv := &server{streamTickets: newSessionStore(""), localRuntime: &consoleLocalRuntime{notificationHub: hub}}
	httpServer := httptest.NewServer(http.HandlerFunc(srv.handleNotificationWebSocket))
	defer httpServer.Close()
	publish := func(id string) {
		hub.PublishTaskCompletion(daemonruntime.TaskInfo{ID: id, Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: id, TopicID: "topic-1", Status: daemonruntime.TaskDone}, chatTrigger)
	}
	publish("before-first-load")
	for _, id := range []string{"first-live", "after-reconnect"} {
		ticket, _, err := srv.streamTickets.Create(time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"?ticket="+ticket, http.Header{"Origin": []string{httpServer.URL}})
		if err != nil {
			t.Fatal(err)
		}
		publish(id)
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var event consoleNotification
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event.ID != "topic-task:"+id || event.TopicID != "topic-1" {
			t.Fatalf("unexpected event: %#v", event)
		}
		_ = conn.Close()
	}
}

// Neither a scheduled run's opt-in notification nor its completion reaches the socket; the next
// live event, a manual run's, is the first frame.
func TestNotificationWebSocketSkipsScheduledCronRuns(t *testing.T) {
	hub := newConsoleNotificationHub()
	srv := &server{streamTickets: newSessionStore(""), localRuntime: &consoleLocalRuntime{notificationHub: hub}}
	httpServer := httptest.NewServer(http.HandlerFunc(srv.handleNotificationWebSocket))
	defer httpServer.Close()
	ticket, _, err := srv.streamTickets.Create(time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"?ticket="+ticket, http.Header{"Origin": []string{httpServer.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	for _, status := range []daemonruntime.TaskStatus{daemonruntime.TaskDone, daemonruntime.TaskFailed} {
		hub.PublishTaskCompletion(daemonruntime.TaskInfo{ID: "scheduled", Status: daemonruntime.TaskRunning}, daemonruntime.TaskInfo{ID: "scheduled", TopicID: daemonruntime.CronTopicID("todo"), Status: status}, scheduledCronTrigger)
	}
	hub.Publish(awarenessloop.CronNotification{ID: "scheduled", Title: "Daily review", Trigger: awarenessloop.CronNotificationTriggerSchedule})
	hub.Publish(awarenessloop.CronNotification{ID: "manual", Title: "Daily review", Body: "Done."})

	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var got map[string]any
	if err := conn.ReadJSON(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got["id"] != "manual" {
		t.Fatalf("first frame = %#v, want the manual run's", got)
	}
}

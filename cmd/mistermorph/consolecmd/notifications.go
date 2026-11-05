package consolecmd

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	awarenessloop "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// Topic events carry identifiers and status only, never task text or output.
type consoleNotification struct {
	*awarenessloop.CronNotification
	ID      string `json:"id"`
	Type    string `json:"type,omitempty"`
	TopicID string `json:"topic_id,omitempty"`
	Status  string `json:"status,omitempty"`
}

type consoleNotificationHub struct {
	mu   sync.RWMutex
	subs map[chan consoleNotification]struct{}
}

func newConsoleNotificationHub() *consoleNotificationHub {
	return &consoleNotificationHub{subs: map[chan consoleNotification]struct{}{}}
}

func (h *consoleNotificationHub) Subscribe() (<-chan consoleNotification, func()) {
	if h == nil {
		ch := make(chan consoleNotification)
		close(ch)
		return ch, func() {}
	}
	ch := make(chan consoleNotification, 8)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
	}
}

func (h *consoleNotificationHub) Publish(notification awarenessloop.CronNotification) {
	notification.ID = strings.TrimSpace(notification.ID)
	notification.Title = strings.TrimSpace(notification.Title)
	notification.Body = strings.TrimSpace(notification.Body)
	h.publish(consoleNotification{ID: notification.ID, CronNotification: &notification})
}

func (h *consoleNotificationHub) PublishTaskCompletion(previous, next daemonruntime.TaskInfo) {
	if previous.ID == "" || next.ID == "" || strings.TrimSpace(next.TopicID) == "" || next.SteerTargetTaskID != "" {
		return
	}
	// TODO runs retain their existing opt-in cron notification behavior.
	if daemonruntime.IsCronTopicID(next.TopicID) {
		return
	}
	// Only the person's own chats notify. A heartbeat run in Awareness, or a task another agent
	// started over Agent Link, is not something the person is waiting for.
	if strings.TrimSpace(next.TopicID) == daemonruntime.ConsoleAwarenessTopicID || daemonruntime.IsAgentLinkTopicID(next.TopicID) {
		return
	}
	switch previous.Status {
	case daemonruntime.TaskQueued, daemonruntime.TaskRunning, daemonruntime.TaskPending:
	default:
		return
	}
	if next.Status != daemonruntime.TaskDone && next.Status != daemonruntime.TaskFailed {
		return
	}
	h.publish(consoleNotification{
		ID:      "topic-task:" + next.ID,
		Type:    "topic_task_completed",
		TopicID: next.TopicID,
		Status:  string(next.Status),
	})
}

func (h *consoleNotificationHub) publish(notification consoleNotification) {
	if h == nil || notification.ID == "" {
		return
	}
	h.mu.RLock()
	subs := make([]chan consoleNotification, 0, len(h.subs))
	for sub := range h.subs {
		subs = append(subs, sub)
	}
	h.mu.RUnlock()
	for _, sub := range subs {
		select {
		case sub <- notification:
		default:
			select {
			case <-sub:
			default:
			}
			select {
			case sub <- notification:
			default:
			}
		}
	}
}

func (s *server) handleNotificationWebSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s == nil || s.localRuntime == nil || s.localRuntime.notificationHub == nil {
		writeError(w, http.StatusServiceUnavailable, "notifications are unavailable")
		return
	}
	if !s.webSockets.Begin() {
		writeError(w, http.StatusServiceUnavailable, "notifications are shutting down")
		return
	}
	defer s.webSockets.Done()

	ticket := strings.TrimSpace(r.URL.Query().Get("ticket"))
	if ticket == "" {
		writeError(w, http.StatusBadRequest, "missing ticket")
		return
	}
	if _, ok := s.streamTickets.Validate(ticket); !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	s.streamTickets.Delete(ticket)
	events, unsubscribe := s.localRuntime.notificationHub.Subscribe()
	defer unsubscribe()

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return sameOriginRequest(r)
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	if !s.webSockets.Track(conn) {
		_ = conn.Close()
		return
	}

	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	defer func() {
		_ = conn.Close()
		<-readDone
		s.webSockets.Untrack(conn)
	}()

	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(event); err != nil {
				return
			}
		case <-pingTicker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-readDone:
			return
		case <-r.Context().Done():
			return
		}
	}
}

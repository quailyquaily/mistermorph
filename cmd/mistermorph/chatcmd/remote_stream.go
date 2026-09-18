package chatcmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/charmbracelet/x/ansi"

	tea "charm.land/bubbletea/v2"
	"github.com/gorilla/websocket"
	"github.com/quailyquaily/mistermorph/internal/chattrace"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

const remoteStreamLimit = 4

// Console's stream DTO is private to consolecmd. Decode only the stable wire
// fields used here; snapshots replace text, they are not token deltas.
type remoteStreamFrame struct {
	Trace     *chattrace.Snapshot `json:"trace,omitempty"`
	TaskID    string              `json:"task_id"`
	Seq       uint64              `json:"seq"`
	Text      string              `json:"text"`
	Reasoning string              `json:"reasoning"`
	Done      bool                `json:"done"`
	Plan      *struct {
		Steps []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"steps"`
	} `json:"plan"`
	Activity *struct {
		Current *remoteStreamActivity  `json:"current"`
		History []remoteStreamActivity `json:"history"`
	} `json:"activity"`
}

// Args are deliberately not displayed: raw tool arguments are noisy and may
// contain credentials. Console provides summary/output/error for presentation.
type remoteStreamActivity struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	Summary string `json:"summary"`
	Output  string `json:"output"`
	Error   string `json:"error"`
}

func (c *remoteClient) openStream(ctx context.Context, id string) (*websocket.Conn, error) {
	u, err := url.Parse(c.base + "/stream/ws")
	if err != nil {
		return nil, errors.New("invalid runtime stream URL")
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.RawQuery = url.Values{"task_id": {id}}.Encode()
	d := *websocket.DefaultDialer
	d.HandshakeTimeout = 10 * time.Second
	conn, resp, err := d.DialContext(ctx, u.String(), http.Header{"Authorization": {"Bearer " + c.token}})
	if err != nil {
		if resp != nil {
			resp.Body.Close()
			return nil, &remoteHTTPError{resp.StatusCode}
		}
		return nil, errors.New("runtime stream unavailable; HTTP polling continues")
	}
	conn.SetReadLimit(1 << 20)
	// DialContext only covers the handshake, not subsequent blocking reads.
	context.AfterFunc(ctx, func() { conn.Close() })
	return conn, nil
}

type remoteStreamSub struct {
	ctx            context.Context
	cancel         context.CancelFunc
	events         chan remoteStreamEvent
	seq            uint64
	text, activity string
	reasoning      string
	plan, history  []string
	ended          bool
	hasTrace       bool
	retry          time.Time
	backoff        time.Duration
}
type remoteStreamEvent struct {
	gen   uint64
	id    string
	sub   *remoteStreamSub
	frame remoteStreamFrame
	err   error
}

func (m *chatModel) closeStreams() {
	for _, s := range m.streams {
		s.cancel()
	}
	m.streams = nil
}
func remoteStreamActive(t taskdomain.TaskInfo) bool {
	return t.Status == taskdomain.TaskQueued || t.Status == taskdomain.TaskRunning || t.Status == taskdomain.TaskPending
}
func (m *chatModel) syncStreams() tea.Cmd {
	if m.listing || m.deleted || m.id == "" {
		m.closeStreams()
		return nil
	}
	if m.streams == nil {
		m.streams = map[string]*remoteStreamSub{}
	}
	for id, s := range m.streams {
		t, ok := m.tasks[id]
		if !ok || !remoteStreamActive(t) || t.TopicID != m.id {
			s.cancel()
			delete(m.streams, id)
		}
	}
	ids := make([]string, 0)
	for id, t := range m.tasks {
		if remoteStreamActive(t) && t.TopicID == m.id {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	var cmds []tea.Cmd
	for _, id := range ids {
		old := m.streams[id]
		if old != nil && (!old.ended || old.retry.IsZero() || time.Now().Before(old.retry)) {
			continue
		}
		if old == nil && len(m.streams) >= remoteStreamLimit {
			continue
		}
		backoff := 3 * time.Second
		if old != nil {
			old.cancel()
			backoff = min(30*time.Second, old.backoff*2)
		}
		ctx, cancel := context.WithCancel(m.viewCtx)
		s := &remoteStreamSub{ctx: ctx, cancel: cancel, events: make(chan remoteStreamEvent, 1), backoff: backoff}
		m.streams[id] = s
		c, g := m.client, m.gen
		cmds = append(cmds, func() tea.Msg {
			go func() {
				defer cancel()
				emit := func(e remoteStreamEvent) bool {
					select {
					case s.events <- e:
						return true
					case <-ctx.Done():
						return false
					}
				}
				conn, err := c.openStream(ctx, id)
				if err != nil {
					emit(remoteStreamEvent{gen: g, id: id, sub: s, err: err})
					return
				}
				defer conn.Close()
				// Console pings every 25s. A missing ping bounds silent broken connections.
				conn.SetReadDeadline(time.Now().Add(90 * time.Second))
				conn.SetPingHandler(func(data string) error {
					conn.SetReadDeadline(time.Now().Add(90 * time.Second))
					return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
				})
				for {
					var f remoteStreamFrame
					err := conn.ReadJSON(&f)
					if err != nil {
						emit(remoteStreamEvent{gen: g, id: id, sub: s, err: errors.New("stream disconnected")})
						return
					}
					if !emit(remoteStreamEvent{gen: g, id: id, sub: s, frame: f}) {
						return
					}
				}
			}()
			return remoteStreamWait(s)()
		})
	}
	return tea.Batch(cmds...)
}
func remoteStreamWait(s *remoteStreamSub) tea.Cmd {
	return func() tea.Msg {
		// Drain a queued error even when the worker has already exited.
		select {
		case e := <-s.events:
			return e
		default:
		}
		select {
		case e := <-s.events:
			return e
		case <-s.ctx.Done():
			select {
			case e := <-s.events:
				return e
			default:
				return nil
			}
		}
	}
}
func (m *chatModel) streamUpdate(e remoteStreamEvent) tea.Cmd {
	s := m.streams[e.id]
	if e.gen != m.gen || s == nil || s != e.sub || m.listing || m.deleted {
		return nil
	}
	if e.err != nil {
		s.cancel()
		s.ended = true
		s.retry = time.Now().Add(s.backoff)
		s.text = ""
		s.activity = ""
		s.reasoning = ""
		s.plan, s.history = nil, nil
		return nil
	}
	f := e.frame
	if f.TaskID != e.id || f.Seq <= s.seq {
		return remoteStreamWait(s)
	}
	s.seq = f.Seq
	var transcript tea.Cmd
	if f.Trace != nil {
		s.hasTrace = true
		transcript = m.enqueueTranscript(strings.TrimSuffix(m.renderSharedTrace(e.id, *f.Trace, false), "\n"))
	}
	s.text = remoteStreamText(f.Text, 1200)
	s.reasoning = remoteStreamText(f.Reasoning, 1600)
	s.plan, s.history = nil, nil
	s.activity = ""
	if f.Plan != nil {
		for i, step := range f.Plan.Steps {
			if i == 6 {
				s.plan = append(s.plan, fmt.Sprintf("… %d more steps", len(f.Plan.Steps)-i))
				break
			}
			s.plan = append(s.plan, fmt.Sprintf("%d. [%s] %s", i+1, remoteStreamSnippet(step.Status, 24), remoteStreamSnippet(step.Step, 200)))
		}
	}
	if f.Activity != nil {
		entries := f.Activity.History
		// Current is commonly also the last history entry; show its newest version
		// once, at the end. Do not merge snapshots into an invented event log.
		for _, a := range entries {
			if f.Activity.Current != nil && a.ID != "" && a.ID == f.Activity.Current.ID {
				continue
			}
			s.history = append(s.history, remoteStreamActivityLine(a))
			if len(s.history) > 4 {
				s.history = s.history[1:]
			}
		}
		if a := f.Activity.Current; a != nil {
			s.activity = remoteStreamActivityLine(*a)
		}
		if len(entries) > 4 {
			s.history = append([]string{"… earlier activity omitted"}, s.history...)
		}
	}

	if f.Done {
		// Even a final WS snapshot is only a preview. HTTP owns terminal state.
		s.cancel()
		s.ended = true
		s.retry = time.Time{}
		return transcript
	}
	return tea.Batch(transcript, remoteStreamWait(s))
}
func remoteStreamSnippet(text string, limit int) string {
	text = strings.Join(strings.Fields(remoteStreamText(text, 0)), " ")
	r := []rune(text)
	if len(r) > limit {
		return "…" + string(r[len(r)-limit:])
	}
	return text
}

// Keep multiline snapshots readable while bounding retained state. Strip
// terminal escapes and Unicode format controls (including bidi overrides).
func remoteStreamText(text string, limit int) string {
	text = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, remoteDisplay(text))
	r := []rune(strings.TrimSpace(text))
	if limit > 0 && len(r) > limit {
		return "…" + string(r[len(r)-limit:])
	}
	return string(r)
}

func remoteStreamActivityLine(a remoteStreamActivity) string {
	label := remoteStreamSnippet(strings.TrimSpace(a.Kind+" "+a.Name+" "+a.Status), 100)
	for _, detail := range []string{a.Summary, a.Output, a.Error} {
		if detail != "" {
			label += " · " + remoteStreamSnippet(detail, 160)
		}
	}
	return label
}

func (m *chatModel) streamView() string {
	ids := make([]string, 0, len(m.streams))
	for id := range m.streams {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var b strings.Builder
	width := max(1, m.textarea.Width())
	line := func(text string) { b.WriteString(ansi.Truncate(text, width, "…") + "\n") }
	// Fixed row budgets keep stream snapshots from growing with task duration.
	// Width is measured in terminal cells, not bytes or Unicode code points.
	block := func(label, text string, rows int) {
		if text == "" {
			return
		}
		line(label)
		wrapped := strings.Split(ansi.Hardwrap(strings.ReplaceAll(text, "\t", "  "), width, true), "\n")
		if len(wrapped) > rows {
			wrapped = wrapped[len(wrapped)-rows:]
			wrapped[0] = "…" + wrapped[0]
		}
		for _, row := range wrapped {
			line(row)
		}
	}
	for _, id := range ids {
		s := m.streams[id]
		label := "Running"
		switch m.tasks[id].Status {
		case taskdomain.TaskQueued:
			label = "Queued"
		case taskdomain.TaskPending:
			label = "Waiting for approval"
		}
		if !s.retry.IsZero() {
			label = "stream offline; HTTP polling"
		} else if s.ended {
			label = "awaiting HTTP result"
		}
		if !m.thinking || !s.retry.IsZero() || s.ended {
			line(label)
		}
		block("Reasoning", s.reasoning, 4)
		if !s.hasTrace && len(s.plan) > 0 {
			line("Plan")
			for _, step := range s.plan {
				line(step)
			}
		}
		if !s.hasTrace && (len(s.history) > 0 || s.activity != "") {
			line("Activity")
			for _, entry := range s.history {
				line(entry)
			}
			if s.activity != "" {
				line(s.activity)
			}
		}
		block("Response preview", s.text, 3)
	}
	return b.String()
}

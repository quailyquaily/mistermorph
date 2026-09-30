package discordapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeGateway serves one scripted connection after another.
type fakeGateway struct {
	t       *testing.T
	server  *httptest.Server
	mu      sync.Mutex
	scripts []func(*gatewayConn)
	conns   int
}

type gatewayConn struct {
	t    *testing.T
	ws   *websocket.Conn
	url  string
	path string
}

func newFakeGateway(t *testing.T, scripts ...func(*gatewayConn)) *fakeGateway {
	t.Helper()
	g := &fakeGateway{t: t, scripts: scripts}
	upgrader := websocket.Upgrader{}
	g.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		index := g.conns
		g.conns++
		g.mu.Unlock()
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		if index >= len(g.scripts) {
			// No more scripts: hold the connection until the client leaves.
			for {
				if _, _, err := ws.ReadMessage(); err != nil {
					return
				}
			}
		}
		g.scripts[index](&gatewayConn{t: t, ws: ws, url: g.wsURL(), path: r.URL.Path + "?" + r.URL.RawQuery})
	}))
	t.Cleanup(g.server.Close)
	return g
}

func (g *fakeGateway) wsURL() string {
	return "ws" + strings.TrimPrefix(g.server.URL, "http")
}

func (c *gatewayConn) send(op int, eventType string, seq int64, data any) {
	payload := map[string]any{"op": op, "d": data}
	if eventType != "" {
		payload["t"] = eventType
		payload["s"] = seq
	}
	if err := c.ws.WriteJSON(payload); err != nil {
		c.t.Errorf("fake gateway write: %v", err)
	}
}

func (c *gatewayConn) hello(interval time.Duration) {
	c.send(opHello, "", 0, map[string]any{"heartbeat_interval": interval.Milliseconds()})
}

// read returns the next client payload, answering heartbeats when ack is true.
func (c *gatewayConn) read(ack bool) (int, map[string]any) {
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			return -1, nil
		}
		var payload struct {
			Op   int            `json:"op"`
			Data map[string]any `json:"d"`
		}
		_ = json.Unmarshal(data, &payload)
		if payload.Op == opHeartbeat {
			if ack {
				c.send(opHeartbeatAck, "", 0, nil)
			}
			continue
		}
		return payload.Op, payload.Data
	}
}

// drain answers heartbeats until the client closes.
func (c *gatewayConn) drain() {
	for {
		if op, _ := c.read(true); op == -1 {
			return
		}
	}
}

type recorded struct {
	mu     sync.Mutex
	events []Event
	states []bool
}

func (r *recorded) handler(cancelOn func(Event) bool, cancel context.CancelFunc) EventHandler {
	return func(_ context.Context, event Event) {
		r.mu.Lock()
		r.events = append(r.events, event)
		r.mu.Unlock()
		if cancelOn != nil && cancelOn(event) {
			cancel()
		}
	}
}

func (r *recorded) types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, event := range r.events {
		out = append(out, event.Type)
	}
	return out
}

func newTestGateway(t *testing.T, url string, rec *recorded) *Gateway {
	t.Helper()
	g, err := NewGateway("bot-token", GatewayOptions{
		URL:        url,
		Intents:    IntentGuilds | IntentGuildMessages | IntentDirectMessages,
		MinBackoff: time.Millisecond,
		MaxBackoff: 5 * time.Millisecond,
		OnConnectionChange: func(connected bool) {
			rec.mu.Lock()
			rec.states = append(rec.states, connected)
			rec.mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	g.invalidSessionDelay = func() time.Duration { return time.Millisecond }
	return g
}

func TestGatewayIdentifiesDispatchesAndResumesAfterReconnect(t *testing.T) {
	var identify, resume map[string]any
	var firstPath string
	var gw *fakeGateway
	gw = newFakeGateway(t,
		func(c *gatewayConn) {
			firstPath = c.path
			c.hello(time.Hour)
			op, data := c.read(true)
			if op != opIdentify {
				t.Errorf("first op = %d, want identify", op)
			}
			identify = data
			c.send(opDispatch, "READY", 1, map[string]any{"session_id": "sess-1", "resume_gateway_url": gw.wsURL() + "/resume", "user": map[string]any{"id": "42", "username": "morph", "bot": true}})
			c.send(opDispatch, "MESSAGE_CREATE", 2, map[string]any{"id": "900", "channel_id": "100", "content": "hi", "author": map[string]any{"id": "7", "username": "ann"}})
			c.send(opReconnect, "", 0, nil)
			c.drain()
		},
		func(c *gatewayConn) {
			if !strings.HasPrefix(c.path, "/resume?") {
				t.Errorf("resumed on %q, want the resume URL", c.path)
			}
			c.hello(time.Hour)
			op, data := c.read(true)
			if op != opResume {
				t.Errorf("op after reconnect = %d, want resume", op)
			}
			resume = data
			c.send(opDispatch, "RESUMED", 3, map[string]any{})
			c.send(opDispatch, "MESSAGE_CREATE", 4, map[string]any{"id": "901", "channel_id": "100", "content": "again", "author": map[string]any{"id": "7", "username": "ann"}})
			c.drain()
		},
	)
	rec := &recorded{}
	g := newTestGateway(t, gw.wsURL(), rec)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := g.Run(ctx, rec.handler(func(e Event) bool { return e.Seq == 4 }, cancel))
	if err != context.Canceled {
		t.Fatalf("Run = %v, want canceled", err)
	}
	if got := strings.Join(rec.types(), ","); got != "READY,MESSAGE_CREATE,RESUMED,MESSAGE_CREATE" {
		t.Fatalf("events = %s", got)
	}
	if !strings.Contains(firstPath, "v=10") || !strings.Contains(firstPath, "encoding=json") {
		t.Fatalf("gateway query = %q", firstPath)
	}
	if identify["token"] != "bot-token" || identify["intents"] != float64(IntentGuilds|IntentGuildMessages|IntentDirectMessages) {
		t.Fatalf("identify = %v", identify)
	}
	if resume["session_id"] != "sess-1" || resume["seq"] != float64(2) || resume["token"] != "bot-token" {
		t.Fatalf("resume = %v", resume)
	}
	var message Message
	if err := DecodeEvent(rec.events[1], EventMessageCreate, &message); err != nil || message.ID != "900" || message.Author.ID != "7" {
		t.Fatalf("message = %+v, %v", message, err)
	}
	rec.mu.Lock()
	states := rec.states
	rec.mu.Unlock()
	if len(states) < 3 || !states[0] || states[1] || !states[2] {
		t.Fatalf("connection states = %v, want up, down, up", states)
	}
}

func TestGatewayStopsOnAFatalClose(t *testing.T) {
	gw := newFakeGateway(t, func(c *gatewayConn) {
		c.hello(time.Hour)
		c.read(true)
		_ = c.ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(CloseAuthenticationFailed, "Authentication failed."))
		c.drain()
	})
	rec := &recorded{}
	g := newTestGateway(t, gw.wsURL(), rec)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := g.Run(ctx, rec.handler(nil, cancel))
	if !IsFatalGatewayError(err) || !strings.Contains(err.Error(), "bot token") {
		t.Fatalf("Run = %v, want a fatal authentication error", err)
	}
}

func TestGatewayIdentifiesAgainAfterANonResumableInvalidSession(t *testing.T) {
	var secondOp int
	gw := newFakeGateway(t,
		func(c *gatewayConn) {
			c.hello(time.Hour)
			c.read(true)
			c.send(opDispatch, "READY", 1, map[string]any{"session_id": "sess-1", "resume_gateway_url": "ws://127.0.0.1:1"})
			c.send(opInvalidSession, "", 0, false)
			c.drain()
		},
		func(c *gatewayConn) {
			c.hello(time.Hour)
			secondOp, _ = c.read(true)
			c.send(opDispatch, "READY", 1, map[string]any{"session_id": "sess-2"})
			c.drain()
		},
	)
	rec := &recorded{}
	g := newTestGateway(t, gw.wsURL(), rec)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ready := 0
	_ = g.Run(ctx, rec.handler(func(e Event) bool {
		if e.Type == EventReady {
			ready++
		}
		return ready == 2
	}, cancel))
	if secondOp != opIdentify {
		t.Fatalf("op after invalid session = %d, want identify", secondOp)
	}
}

func TestGatewayResumesWhenHeartbeatsGoUnacknowledged(t *testing.T) {
	var secondOp int
	gw := newFakeGateway(t,
		func(c *gatewayConn) {
			c.hello(20 * time.Millisecond)
			c.read(false)
			c.send(opDispatch, "READY", 1, map[string]any{"session_id": "sess-1"})
			for {
				if op, _ := c.read(false); op == -1 {
					return
				}
			}
		},
		func(c *gatewayConn) {
			c.hello(time.Hour)
			secondOp, _ = c.read(true)
			c.send(opDispatch, "RESUMED", 2, map[string]any{})
			c.drain()
		},
	)
	rec := &recorded{}
	g := newTestGateway(t, gw.wsURL(), rec)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = g.Run(ctx, rec.handler(func(e Event) bool { return e.Type == "RESUMED" }, cancel))
	if secondOp != opResume {
		t.Fatalf("op after a missed heartbeat ack = %d, want resume", secondOp)
	}
}

func TestInteractionActor(t *testing.T) {
	inGuild := Interaction{Member: &InteractionMember{User: User{ID: "1"}}, User: &User{ID: "2"}}
	inDM := Interaction{User: &User{ID: "2"}}
	if inGuild.Actor().ID != "1" || inDM.Actor().ID != "2" {
		t.Fatalf("actors = %q, %q", inGuild.Actor().ID, inDM.Actor().ID)
	}
}

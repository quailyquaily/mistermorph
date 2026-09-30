package discordapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Gateway intents the channel uses. MessageContent is privileged: it must be switched on for the bot
// in the Developer Portal, or Discord closes the connection with 4014.
const (
	IntentGuilds         = 1 << 0
	IntentGuildMessages  = 1 << 9
	IntentDirectMessages = 1 << 12
	IntentMessageContent = 1 << 15
)

// Gateway opcodes.
const (
	opDispatch       = 0
	opHeartbeat      = 1
	opIdentify       = 2
	opResume         = 6
	opReconnect      = 7
	opInvalidSession = 9
	opHello          = 10
	opHeartbeatAck   = 11
)

// Gateway close codes the client acts on.
const (
	CloseAuthenticationFailed = 4004
	CloseInvalidSeq           = 4007
	CloseSessionTimedOut      = 4009
	CloseInvalidShard         = 4010
	CloseShardingRequired     = 4011
	CloseInvalidAPIVersion    = 4012
	CloseInvalidIntents       = 4013
	CloseDisallowedIntents    = 4014
)

const (
	gatewayVersion           = "10"
	defaultGatewayMinBackoff = time.Second
	defaultGatewayMaxBackoff = 30 * time.Second
	gatewayWriteTimeout      = 10 * time.Second
	gatewayHelloTimeout      = 30 * time.Second
	maxGatewayMessageBytes   = 16 << 20
)

// Event is one Gateway dispatch: its type (MESSAGE_CREATE, READY, ...), sequence number and payload.
type Event struct {
	Type string
	Seq  int64
	Data json.RawMessage
}

// EventHandler receives dispatches in order. It runs on the read loop, so it should hand work off
// rather than do it.
type EventHandler func(context.Context, Event)

// GatewayCloseError is a close frame from Discord.
type GatewayCloseError struct {
	Code   int
	Reason string
}

func (e *GatewayCloseError) Error() string {
	if e == nil {
		return "discord gateway closed"
	}
	switch e.Code {
	case CloseAuthenticationFailed:
		return "discord gateway: authentication failed; check the bot token"
	case CloseDisallowedIntents:
		return "discord gateway: disallowed intents; enable the Message Content intent for the bot in the Developer Portal, or use group_trigger_mode strict"
	}
	if reason := strings.TrimSpace(e.Reason); reason != "" {
		return fmt.Sprintf("discord gateway closed: code=%d reason=%s", e.Code, reason)
	}
	return fmt.Sprintf("discord gateway closed: code=%d", e.Code)
}

// IsFatalGatewayError reports a close that reconnecting cannot fix: a bad token, bad intents, or a
// configuration Discord refuses.
func IsFatalGatewayError(err error) bool {
	var closeErr *GatewayCloseError
	if !errors.As(err, &closeErr) {
		return false
	}
	switch closeErr.Code {
	case CloseAuthenticationFailed, CloseInvalidShard, CloseShardingRequired, CloseInvalidAPIVersion, CloseInvalidIntents, CloseDisallowedIntents:
		return true
	}
	return false
}

type GatewayOptions struct {
	// URL is the Gateway URL from GatewayBot.
	URL                string
	Intents            int
	Dialer             *websocket.Dialer
	MinBackoff         time.Duration
	MaxBackoff         time.Duration
	OnConnectionChange func(connected bool)
	OnReconnect        func(err error, delay time.Duration)
}

// Gateway keeps one Gateway session: it identifies, heartbeats, resumes after drops, and hands
// dispatches to the handler.
type Gateway struct {
	token              string
	url                string
	intents            int
	dialer             *websocket.Dialer
	minBackoff         time.Duration
	maxBackoff         time.Duration
	onConnectionChange func(bool)
	onReconnect        func(error, time.Duration)
	// invalidSessionDelay is the pause Discord asks for after an invalid session.
	invalidSessionDelay func() time.Duration

	mu        sync.Mutex
	sessionID string
	resumeURL string
	seq       int64
}

func NewGateway(token string, opts GatewayOptions) (*Gateway, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("discord bot token is required")
	}
	gatewayURL, err := normalizeGatewayURL(opts.URL)
	if err != nil {
		return nil, err
	}
	dialer := opts.Dialer
	if dialer == nil {
		clone := *websocket.DefaultDialer
		dialer = &clone
	}
	minBackoff := opts.MinBackoff
	if minBackoff <= 0 {
		minBackoff = defaultGatewayMinBackoff
	}
	maxBackoff := opts.MaxBackoff
	if maxBackoff <= 0 {
		maxBackoff = defaultGatewayMaxBackoff
	}
	if maxBackoff < minBackoff {
		maxBackoff = minBackoff
	}
	return &Gateway{
		token:              token,
		url:                gatewayURL,
		intents:            opts.Intents,
		dialer:             dialer,
		minBackoff:         minBackoff,
		maxBackoff:         maxBackoff,
		onConnectionChange: opts.OnConnectionChange,
		onReconnect:        opts.OnReconnect,
		invalidSessionDelay: func() time.Duration {
			return time.Second + time.Duration(rand.Int64N(int64(4*time.Second)))
		},
	}, nil
}

// Run connects and stays connected until ctx ends or Discord closes with a fatal code.
func (g *Gateway) Run(ctx context.Context, handler EventHandler) error {
	if g == nil {
		return fmt.Errorf("discord gateway is not initialized")
	}
	if handler == nil {
		return fmt.Errorf("discord gateway event handler is required")
	}
	backoff := g.minBackoff
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		ready, err := g.runConnection(ctx, handler)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if IsFatalGatewayError(err) {
			return err
		}
		if ready {
			backoff = g.minBackoff
		}
		delay := jitter(backoff)
		if g.onReconnect != nil {
			g.onReconnect(err, delay)
		}
		if err := sleepContext(ctx, delay); err != nil {
			return err
		}
		if !ready && backoff < g.maxBackoff {
			backoff *= 2
			if backoff > g.maxBackoff {
				backoff = g.maxBackoff
			}
		}
	}
}

type gatewayPayload struct {
	Op   int             `json:"op"`
	Data json.RawMessage `json:"d,omitempty"`
	Seq  *int64          `json:"s,omitempty"`
	Type string          `json:"t,omitempty"`
}

type outgoingPayload struct {
	Op   int `json:"op"`
	Data any `json:"d"`
}

var errReconnectRequested = errors.New("discord gateway asked to reconnect")
var errInvalidSession = errors.New("discord gateway session is invalid")
var errHeartbeatNotAcked = errors.New("discord gateway heartbeat was not acknowledged")

// runConnection runs one WebSocket connection. ready is true once the session was identified or
// resumed on it.
func (g *Gateway) runConnection(ctx context.Context, handler EventHandler) (ready bool, err error) {
	g.mu.Lock()
	sessionID, resumeURL, seq := g.sessionID, g.resumeURL, g.seq
	g.mu.Unlock()
	target := g.url
	if sessionID != "" && resumeURL != "" {
		target = resumeURL
	}
	conn, _, err := g.dialer.DialContext(ctx, target, nil)
	if err != nil {
		return false, err
	}
	conn.SetReadLimit(maxGatewayMessageBytes)
	var writeMu sync.Mutex
	write := func(op int, data any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(gatewayWriteTimeout))
		return conn.WriteJSON(outgoingPayload{Op: op, Data: data})
	}
	done := make(chan struct{})
	var closeOnce sync.Once
	closeConn := func() { closeOnce.Do(func() { close(done); _ = conn.Close() }) }
	defer closeConn()
	go func() {
		select {
		case <-ctx.Done():
			writeMu.Lock()
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
			writeMu.Unlock()
			closeConn()
		case <-done:
		}
	}()
	defer func() {
		if ready && g.onConnectionChange != nil {
			g.onConnectionChange(false)
		}
	}()

	_ = conn.SetReadDeadline(time.Now().Add(gatewayHelloTimeout))
	hello, err := readPayload(conn)
	if err != nil {
		return false, err
	}
	if hello.Op != opHello {
		return false, fmt.Errorf("discord gateway: expected hello, got op %d", hello.Op)
	}
	var helloData struct {
		HeartbeatInterval int64 `json:"heartbeat_interval"`
	}
	if err := json.Unmarshal(hello.Data, &helloData); err != nil || helloData.HeartbeatInterval <= 0 {
		return false, fmt.Errorf("discord gateway: invalid hello")
	}
	interval := time.Duration(helloData.HeartbeatInterval) * time.Millisecond
	_ = conn.SetReadDeadline(time.Time{})

	if sessionID != "" {
		err = write(opResume, map[string]any{"token": g.token, "session_id": sessionID, "seq": seq})
	} else {
		err = write(opIdentify, map[string]any{
			"token":   g.token,
			"intents": g.intents,
			"properties": map[string]string{
				"os":      runtime.GOOS,
				"browser": "mistermorph",
				"device":  "mistermorph",
			},
		})
	}
	if err != nil {
		return false, err
	}

	// Heartbeats: the first after a random part of the interval, then every interval. One not
	// acknowledged by the time the next is due means the connection is dead.
	var ackMu sync.Mutex
	acked := true
	heartbeat := func() error {
		g.mu.Lock()
		current := g.seq
		g.mu.Unlock()
		var data any
		if current > 0 {
			data = current
		}
		return write(opHeartbeat, data)
	}
	heartbeatErr := make(chan error, 1)
	go func() {
		timer := time.NewTimer(time.Duration(rand.Float64() * float64(interval)))
		defer timer.Stop()
		for {
			select {
			case <-done:
				return
			case <-timer.C:
			}
			ackMu.Lock()
			missed := !acked
			acked = false
			ackMu.Unlock()
			if missed {
				heartbeatErr <- errHeartbeatNotAcked
				closeConn()
				return
			}
			if err := heartbeat(); err != nil {
				heartbeatErr <- err
				closeConn()
				return
			}
			timer.Reset(interval)
		}
	}()

	for {
		payload, err := readPayload(conn)
		if err != nil {
			select {
			case hbErr := <-heartbeatErr:
				return ready, hbErr
			default:
			}
			return ready, g.connectionError(err)
		}
		switch payload.Op {
		case opDispatch:
			if payload.Seq != nil && *payload.Seq > 0 {
				g.mu.Lock()
				g.seq = *payload.Seq
				g.mu.Unlock()
			}
			switch payload.Type {
			case "READY":
				var readyData struct {
					SessionID        string `json:"session_id"`
					ResumeGatewayURL string `json:"resume_gateway_url"`
				}
				if err := json.Unmarshal(payload.Data, &readyData); err == nil {
					resume, _ := normalizeGatewayURL(readyData.ResumeGatewayURL)
					g.mu.Lock()
					g.sessionID = readyData.SessionID
					g.resumeURL = resume
					g.mu.Unlock()
				}
				ready = g.markReady(ready)
			case "RESUMED":
				ready = g.markReady(ready)
			}
			event := Event{Type: payload.Type, Data: payload.Data}
			if payload.Seq != nil {
				event.Seq = *payload.Seq
			}
			handler(ctx, event)
		case opHeartbeat:
			if err := heartbeat(); err != nil {
				return ready, err
			}
		case opHeartbeatAck:
			ackMu.Lock()
			acked = true
			ackMu.Unlock()
		case opReconnect:
			return ready, errReconnectRequested
		case opInvalidSession:
			var resumable bool
			_ = json.Unmarshal(payload.Data, &resumable)
			if !resumable {
				g.resetSession()
			}
			// Discord asks for a pause of 1 to 5 seconds before identifying again.
			if err := sleepContext(ctx, g.invalidSessionDelay()); err != nil {
				return ready, err
			}
			return ready, errInvalidSession
		}
	}
}

func (g *Gateway) markReady(ready bool) bool {
	if !ready && g.onConnectionChange != nil {
		g.onConnectionChange(true)
	}
	return true
}

// connectionError turns a read error into a close error, and forgets the session when Discord says
// it cannot be resumed.
func (g *Gateway) connectionError(err error) error {
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) {
		return err
	}
	gatewayErr := &GatewayCloseError{Code: closeErr.Code, Reason: closeErr.Text}
	switch closeErr.Code {
	case CloseInvalidSeq, CloseSessionTimedOut:
		g.resetSession()
	}
	if IsFatalGatewayError(gatewayErr) {
		g.resetSession()
	}
	return gatewayErr
}

func (g *Gateway) resetSession() {
	g.mu.Lock()
	g.sessionID, g.resumeURL, g.seq = "", "", 0
	g.mu.Unlock()
}

func readPayload(conn *websocket.Conn) (gatewayPayload, error) {
	var payload gatewayPayload
	_, data, err := conn.ReadMessage()
	if err != nil {
		return payload, err
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return payload, fmt.Errorf("decode discord gateway payload: %w", err)
	}
	return payload, nil
}

// normalizeGatewayURL adds the API version and JSON encoding to a Gateway URL.
func normalizeGatewayURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "wss" && parsed.Scheme != "ws") || parsed.Host == "" {
		return "", fmt.Errorf("discord gateway url is invalid")
	}
	query := parsed.Query()
	query.Set("v", gatewayVersion)
	query.Set("encoding", "json")
	parsed.RawQuery = query.Encode()
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String(), nil
}

func jitter(delay time.Duration) time.Duration {
	if delay <= 2*time.Millisecond {
		return delay
	}
	spread := delay / 5
	return delay - spread + time.Duration(rand.Int64N(int64(spread*2)+1))
}

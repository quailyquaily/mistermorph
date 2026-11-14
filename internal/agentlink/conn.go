package agentlink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// pingInterval is how often a Relay pings each runtime; both sides drop a connection that stays
	// silent for idleTimeout.
	pingInterval = 30 * time.Second
	idleTimeout  = 3 * pingInterval
	writeTimeout = 10 * time.Second
	// maxFrameSize bounds a frame. A runtime or Console that predates file transfer reads at most
	// 1 MiB; only messages with attachments, which go only to peers with CapabilityFiles, are larger.
	maxFrameSize = 4 << 20
	// slowLinkBytesPerSecond is the slowest link a large frame is given time to cross.
	slowLinkBytesPerSecond = 64 << 10
)

// ErrClosed is returned by a closed Conn.
var ErrClosed = errors.New("agentlink: connection closed")

// Conn carries frames between one runtime and one Console.
type Conn interface {
	ReadFrame(ctx context.Context) (Frame, error)
	WriteFrame(ctx context.Context, frame Frame) error
	Close() error
}

type wsConn struct {
	conn      *websocket.Conn
	writeMu   sync.Mutex
	closeOnce sync.Once
}

// NewWebSocketConn wraps an open WebSocket connection.
func NewWebSocketConn(conn *websocket.Conn) Conn {
	conn.SetReadLimit(maxFrameSize)
	return &wsConn{conn: conn}
}

func (c *wsConn) ReadFrame(ctx context.Context) (Frame, error) {
	if err := ctx.Err(); err != nil {
		return Frame{}, err
	}
	_ = c.conn.SetReadDeadline(time.Now().Add(idleTimeout))
	kind, data, err := c.conn.ReadMessage()
	if err != nil {
		if ctx.Err() != nil {
			return Frame{}, ctx.Err()
		}
		return Frame{}, err
	}
	if kind == websocket.BinaryMessage {
		// A binary frame is a file chunk; one that does not parse has no Chunk and is refused by
		// whoever reads it.
		chunk, err := decodeChunk(data)
		if err != nil {
			return Frame{Type: FrameChunk, Reason: err.Error()}, nil
		}
		return Frame{Type: FrameChunk, Chunk: chunk}, nil
	}
	var frame Frame
	if err := json.Unmarshal(data, &frame); err != nil {
		return Frame{}, err
	}
	if frame.Type == FrameChunk {
		// Chunks travel only as binary frames.
		frame.Chunk = nil
	}
	return frame, nil
}

func (c *wsConn) WriteFrame(ctx context.Context, frame Frame) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	kind := websocket.TextMessage
	var data []byte
	var err error
	if frame.Type == FrameChunk {
		if frame.Chunk == nil {
			return fmt.Errorf("agentlink: chunk frame without a chunk")
		}
		kind = websocket.BinaryMessage
		data, err = encodeChunk(frame.Chunk)
	} else {
		data, err = json.Marshal(frame)
	}
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	// An inline file may take longer than writeTimeout to cross a slow link; a chunk is small
	// enough for the fixed deadline.
	deadline := time.Now().Add(writeTimeout + time.Duration(len(data)/slowLinkBytesPerSecond)*time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = c.conn.SetWriteDeadline(deadline)
	return c.conn.WriteMessage(kind, data)
}

func (c *wsConn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		c.writeMu.Lock()
		_ = c.conn.SetWriteDeadline(time.Now().Add(time.Second))
		_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		c.writeMu.Unlock()
		err = c.conn.Close()
	})
	return err
}

// Dial opens the Agent Link stream of the runtime API at baseURL with its bearer token.
func Dial(ctx context.Context, baseURL, authToken string) (Conn, error) {
	target, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("invalid runtime url: %w", err)
	}
	switch strings.ToLower(target.Scheme) {
	case "http":
		target.Scheme = "ws"
	case "https":
		target.Scheme = "wss"
	default:
		return nil, fmt.Errorf("runtime url must use http or https")
	}
	target.Path = strings.TrimRight(target.Path, "/") + WebSocketPath
	header := http.Header{"Authorization": []string{"Bearer " + strings.TrimSpace(authToken)}}
	conn, resp, err := websocket.DefaultDialer.DialContext(ctx, target.String(), header)
	if err == nil {
		return NewWebSocketConn(conn), nil
	}
	if resp == nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	message := strings.TrimSpace(string(raw))
	if message == "" {
		message = err.Error()
	}
	return nil, fmt.Errorf("agent link http %d: %s", resp.StatusCode, message)
}

// pipeConn is one end of an in-process connection. A chunk frame passes as it is; its data is not
// copied, so a writer must not change it afterwards.
type pipeConn struct {
	in    <-chan Frame
	out   chan<- Frame
	done  chan struct{}
	close func()
}

// Pipe returns the two ends of an in-process connection, for a Console and the runtime in its own
// process. Closing either end closes both.
func Pipe() (Conn, Conn) {
	a := make(chan Frame, 64)
	b := make(chan Frame, 64)
	done := make(chan struct{})
	var once sync.Once
	closeBoth := func() { once.Do(func() { close(done) }) }
	return &pipeConn{in: a, out: b, done: done, close: closeBoth}, &pipeConn{in: b, out: a, done: done, close: closeBoth}
}

func (c *pipeConn) ReadFrame(ctx context.Context) (Frame, error) {
	select {
	case <-ctx.Done():
		return Frame{}, ctx.Err()
	case <-c.done:
		return Frame{}, ErrClosed
	case frame := <-c.in:
		return frame, nil
	}
}

func (c *pipeConn) WriteFrame(ctx context.Context, frame Frame) error {
	select {
	case <-c.done:
		return ErrClosed
	default:
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		return ErrClosed
	case c.out <- frame:
		return nil
	}
}

func (c *pipeConn) Close() error {
	c.close()
	return nil
}

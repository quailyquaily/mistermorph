package codersessions

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/proctrack"
)

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
	// line is the whole line, for a CLI whose lines are not JSON-RPC (Claude Code).
	line []byte
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// rpc has one consumer per session. Calls dispatch notifications and server requests while
// waiting for their response, so an approval cannot deadlock a pending prompt.
type rpc struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	out      io.ReadCloser
	messages chan message
	done     chan struct{}
	stopped  chan struct{}
	once     sync.Once
	waitOnce sync.Once
	waited   chan struct{}
	next     int
	err      error
	stderr   stderrTail
}

// stderrTail keeps the end of what the CLI wrote to stderr, for the error of a process that died.
type stderrTail struct {
	mu  sync.Mutex
	buf []byte
}

const stderrTailBytes = 2048

func (t *stderrTail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > stderrTailBytes {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-stderrTailBytes:]...)
	}
	return len(p), nil
}

func (t *stderrTail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(bytes.ToValidUTF8(t.buf, []byte("?"))))
}

func startRPC(req Request, args ...string) (*rpc, error) {
	return startProcess(req, false, args...)
}

// startProcess starts a CLI that talks JSON lines. With lines set, its lines are handed over
// whole (message.line) instead of being read as JSON-RPC messages.
func startProcess(req Request, lines bool, args ...string) (*rpc, error) {
	cmd := exec.CommandContext(context.Background(), req.Command, args...)
	configureCoderProcess(cmd)
	cmd.Dir = req.CWD
	// The server outlives the run that starts it: it carries its own tag, not the run's, so a run
	// can tell what the server left behind from what it keeps (internal/proctrack).
	cmd.Env = append(proctrack.WithoutTags(envOrProcess(req.Env)), proctrack.EnvCoder+"="+uuid.NewString())
	cmd.WaitDelay = time.Second
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	r := &rpc{cmd: cmd, in: in, out: out, messages: make(chan message, 128), done: make(chan struct{}), stopped: make(chan struct{}), waited: make(chan struct{})}
	cmd.Stderr = &r.stderr
	if err = cmd.Start(); err != nil {
		in.Close()
		return nil, err
	}
	go func() {
		defer close(r.done)
		defer close(r.messages)
		scan := bufio.NewScanner(out)
		scan.Buffer(make([]byte, 65536), 8<<20)
		for scan.Scan() {
			var m message
			if lines {
				m.line = append([]byte(nil), scan.Bytes()...)
			} else if err := json.Unmarshal(scan.Bytes(), &m); err != nil {
				r.err = fmt.Errorf("invalid protocol message: %w", err)
				break
			}
			select {
			case r.messages <- m:
			case <-r.stopped:
				return
			}
		}
		if r.err == nil {
			r.err = scan.Err()
		}
	}()
	return r, nil
}
func (r *rpc) close() {
	r.once.Do(func() {
		close(r.stopped)
		r.in.Close()
		_ = r.cmd.Cancel()
		_ = r.out.Close()
		<-r.done
		r.wait()
		<-r.waited
	})
}

// wait reaps the process once; waited closes when it has exited and its stderr was read.
func (r *rpc) wait() {
	r.waitOnce.Do(func() {
		go func() {
			_ = r.cmd.Wait()
			close(r.waited)
		}()
	})
}
func (r *rpc) exited() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}
func (r *rpc) send(v any) error {
	b, err := json.Marshal(v)
	if err == nil {
		_, err = r.in.Write(append(b, '\n'))
	}
	return err
}

// sendCtx is send for a line that can be large (a task): closing stdin interrupts a write that
// blocks because the server stopped reading.
func (r *rpc) sendCtx(ctx context.Context, v any) error {
	stop := context.AfterFunc(ctx, func() { _ = r.in.Close() })
	err := r.send(v)
	stop()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
func (r *rpc) notify(method string, params any) error {
	return r.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}
func (r *rpc) reply(id json.RawMessage, result any) error {
	return r.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}
func (r *rpc) read(ctx context.Context) (message, error) {
	select {
	case <-ctx.Done():
		return message{}, ctx.Err()
	case m, ok := <-r.messages:
		if !ok {
			if r.err != nil {
				return m, r.err
			}
			// The output ended: the process is gone or going. Its last words on stderr say why.
			r.wait()
			select {
			case <-r.waited:
			case <-time.After(500 * time.Millisecond):
			}
			if tail := r.stderr.String(); tail != "" {
				return m, fmt.Errorf("coder server closed its output; stderr: %s", tail)
			}
			return m, fmt.Errorf("coder server closed its output")
		}
		return m, nil
	}
}
func (r *rpc) call(ctx context.Context, method string, params any, handle func(message) error) (json.RawMessage, error) {
	r.next++
	id := fmt.Sprint(r.next)
	if err := r.sendCtx(ctx, map[string]any{"jsonrpc": "2.0", "id": r.next, "method": method, "params": params}); err != nil {
		return nil, err
	}

	for {
		m, err := r.read(ctx)
		if err != nil {
			return nil, err
		}
		if m.Method == "" && string(m.ID) == id {
			if m.Error != nil {
				return nil, fmt.Errorf("%s: %s", method, m.Error.Message)
			}
			return m.Result, nil
		}
		if handle != nil {
			if err := handle(m); err != nil {
				return nil, err
			}
		} else if m.Method != "" && len(m.ID) > 0 {
			return nil, fmt.Errorf("unexpected coder request %s: %s", m.Method, m.Params)
		}
	}
}

func envOrProcess(env []string) []string {
	if env == nil {
		return os.Environ()
	}
	return env
}

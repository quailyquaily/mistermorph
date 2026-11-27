package codersessions

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// callError is a call the server answered with an error: what it reads as is unchanged
// ("method: message"); a backend that needs the code or the data takes them with errors.As.
type callError struct {
	method string
	rpcError
}

func (e *callError) Error() string { return e.method + ": " + e.Message }

// rpc has one consumer per session. Calls dispatch notifications and server requests while
// waiting for their response, so an approval cannot deadlock a pending prompt.
//
// The process is watched from its start (watch): however it ends (a close, a task's
// cancellation, the Console stopping it, a crash, its own exit), it is reaped at once, also while
// its session waits for a task and nobody reads its output.
type rpc struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	out      *os.File
	messages chan message
	done     chan struct{} // the output reader ended
	stopped  chan struct{} // close began
	exit     chan struct{} // the process has exited
	waited   chan struct{} // the process is reaped and its stderr read
	once     sync.Once
	// mu orders signaling the process with reaping it: it is signaled by its pid (its group's id
	// too), which is the process's only until it is reaped.
	mu sync.Mutex
	// released: the process is reaped, or about to be; its pid must not be signaled any more.
	released bool
	// unwatched: its exit cannot be seen before it is reaped (exitWatch failed or is not
	// supported); only the process itself is signaled, through its handle.
	unwatched bool
	next      int
	err       error
	stderr    stderrTail
	// grace is how long close waits for the process to exit by itself, its input closed, before
	// it is killed: a CLI that stops what it started when its input ends, and whose commands a
	// kill of its group would not reach (Grok Build runs them in sessions of their own).
	grace time.Duration
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
	cmd := exec.Command(req.Command, args...)
	configureCoderProcess(cmd)
	cmd.Dir = req.CWD
	// The server outlives the run that starts it: it carries its own tag, not the run's, so a run
	// can tell what the server left behind from what it keeps (internal/proctrack).
	cmd.Env = append(proctrack.WithoutTags(envOrProcess(req.Env)), proctrack.EnvCoder+"="+uuid.NewString())
	// Wait gives up on a stderr that what the process started still holds open this long after
	// it exited.
	cmd.WaitDelay = outputDelay
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	// Not StdoutPipe: Wait would close it, and the reaping does not wait for the output to be
	// read (nobody reads it while the session waits for a task). The reader ends at the end of
	// the output instead, or when what holds it open outlives the process too long.
	out, w, err := os.Pipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	cmd.Stdout = w
	r := &rpc{cmd: cmd, in: in, out: out, messages: make(chan message, 128), done: make(chan struct{}), stopped: make(chan struct{}), exit: make(chan struct{}), waited: make(chan struct{})}
	cmd.Stderr = &r.stderr
	err = cmd.Start()
	w.Close()
	if err != nil {
		in.Close()
		out.Close()
		return nil, err
	}
	go r.watch()
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
		// A closed output is its end: closed by close, or by watch after the process exited.
		if err := scan.Err(); r.err == nil && !errors.Is(err, os.ErrClosed) {
			r.err = err
		}
	}()
	return r, nil
}

// outputDelay is how long the output may stay open after the process exited: what the process
// started (outside its group) can hold it open for good.
const outputDelay = time.Second

// watch is the only waiter of the process. It sees the process exit before reaping it, where the
// system tells (exitWatch): the exited process still holds its pid, so its group is stopped
// safely (nothing else can have its id yet), with what it left running there. Then it reaps it.
func (r *rpc) watch() {
	pid := r.cmd.Process.Pid
	held := exitWatch(pid)
	r.mu.Lock()
	if held {
		_ = killGroup(pid)
		r.released = true
	} else {
		r.unwatched = true
	}
	r.mu.Unlock()
	if held {
		r.markExited()
	}
	_ = r.cmd.Wait()
	if !held {
		r.mu.Lock()
		r.released = true
		r.mu.Unlock()
		r.markExited()
	}
	close(r.waited)
}

// markExited marks the process's exit, and ends its output after outputDelay if nothing else does.
func (r *rpc) markExited() {
	close(r.exit)
	time.AfterFunc(outputDelay, func() {
		select {
		case <-r.done:
		default:
			_ = r.out.Close()
		}
	})
}

// kill stops the process and its group, unless it is reaped (or being reaped) already.
func (r *rpc) kill() {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case r.released:
	case r.unwatched:
		// It can be reaped any time: only its handle knows whether the pid is still its.
		_ = r.cmd.Process.Kill()
	default:
		_ = killGroup(r.cmd.Process.Pid)
	}
}

func (r *rpc) close() {
	r.once.Do(func() {
		close(r.stopped)
		r.in.Close()
		if r.grace > 0 {
			select {
			case <-r.exit:
			case <-time.After(r.grace):
			}
		}
		r.kill()
		_ = r.out.Close()
		<-r.done
		<-r.waited
	})
}

// ended tells whether the process exited or its output ended: it takes no more tasks.
func (r *rpc) ended() bool {
	select {
	case <-r.exit:
		return true
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
func (r *rpc) replyError(id json.RawMessage, code int, message string) error {
	return r.send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
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
			// The output ended: the process is gone or going. Its exit and its last words on
			// stderr say why.
			text := "coder server closed its output"
			select {
			case <-r.waited:
				if state := r.cmd.ProcessState; state != nil {
					text = "coder server exited (" + state.String() + ")"
				}
			case <-time.After(500 * time.Millisecond):
			}
			if tail := r.stderr.String(); tail != "" {
				return m, fmt.Errorf("%s; stderr: %s", text, tail)
			}
			return m, errors.New(text)
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
				return nil, &callError{method: method, rpcError: *m.Error}
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

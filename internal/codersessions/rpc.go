package codersessions

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
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
	next     int
	err      error
}

func startRPC(req Request, args ...string) (*rpc, error) {
	cmd := exec.CommandContext(context.Background(), req.Command, args...)
	configureCoderProcess(cmd)
	cmd.Dir = req.CWD
	cmd.Env = req.Env
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
	r := &rpc{cmd: cmd, in: in, out: out, messages: make(chan message, 128), done: make(chan struct{}), stopped: make(chan struct{})}
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
			if err := json.Unmarshal(scan.Bytes(), &m); err != nil {
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
		_ = r.cmd.Wait()
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
			return m, fmt.Errorf("coder server closed its output")
		}
		return m, nil
	}
}
func (r *rpc) call(ctx context.Context, method string, params any, handle func(message) error) (json.RawMessage, error) {
	r.next++
	id := fmt.Sprint(r.next)
	// Closing stdin interrupts a blocked write of a large task when the server stops reading.
	stop := context.AfterFunc(ctx, func() { _ = r.in.Close() })
	err := r.send(map[string]any{"jsonrpc": "2.0", "id": r.next, "method": method, "params": params})
	stop()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
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

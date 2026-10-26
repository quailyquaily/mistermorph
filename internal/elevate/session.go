package elevate

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Session is where the askpass helper of one elevated command gets its password. It listens on a
// Unix socket in a directory only this user can open; the helper sudo starts connects, shows the
// session's token, and gets back what the approver answered. The password goes from the approver
// to the helper and from there to sudo, nowhere else.
type Session struct {
	dir      string
	listener net.Listener
	token    string
	req      Request
	approver Approver
	ctx      context.Context
	cancel   context.CancelFunc
	// asking serializes the asks: sudo starts the helper again only after the last try failed.
	asking sync.Mutex
	wg     sync.WaitGroup
}

// maxAttempts caps the asks for one command; sudo itself stops after passwd_tries (3 by default).
const maxAttempts = 5

// helperHandshakeTimeout is how long a connection may take to present its token.
const helperHandshakeTimeout = 10 * time.Second

// Begin opens the session for an elevated command that runs in dir until deadline. The approver set
// with WithApprover on ctx asks the user, or else the desktop dialog (cfg.Dialog). Ending ctx gives
// up any ask in progress. The caller ends the session with End once sudo has returned.
func Begin(ctx context.Context, cfg Config, command, dir string, deadline time.Time) (*Session, error) {
	approver, ok := ApproverFromContext(ctx)
	if !ok {
		approver = dialogApprover{configured: strings.TrimSpace(cfg.Dialog)}
	}
	tempDir, err := os.MkdirTemp("", "mm-elevate-")
	if err != nil {
		return nil, fmt.Errorf("make the approval socket's directory: %w", err)
	}
	listener, err := net.Listen("unix", filepath.Join(tempDir, "askpass.sock"))
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("listen for the askpass helper: %w", err)
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		_ = listener.Close()
		_ = os.RemoveAll(tempDir)
		return nil, err
	}
	sessionCtx, cancel := context.WithDeadline(ctx, deadline)
	s := &Session{
		dir:      tempDir,
		listener: listener,
		token:    hex.EncodeToString(token),
		req:      Request{Command: strings.TrimSpace(command), Dir: dir, Deadline: deadline},
		approver: approver,
		ctx:      sessionCtx,
		cancel:   cancel,
	}
	s.wg.Add(1)
	go s.serve()
	return s, nil
}

// End gives up any ask in progress, stops listening and removes the socket.
func (s *Session) End() {
	if s == nil {
		return
	}
	s.cancel()
	_ = s.listener.Close()
	s.wg.Wait()
	_ = os.RemoveAll(s.dir)
}

// Env is what the askpass helper needs to reach the session.
func (s *Session) Env() []string {
	return []string{
		EnvSocket + "=" + s.listener.Addr().String(),
		EnvToken + "=" + s.token,
	}
}

func (s *Session) serve() {
	defer s.wg.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer conn.Close()
			s.answer(conn)
		}()
	}
}

// helperHello is the helper's first line; helperReply is the session's answer.
type helperHello struct {
	Token string `json:"token"`
}

type helperReply struct {
	Status   string `json:"status"`
	Password string `json:"password,omitempty"`
	Error    string `json:"error,omitempty"`
}

const (
	replyAllowed  = "allowed"
	replyDeclined = "declined"
	replyTimedOut = "timed_out"
	replyError    = "error"
)

func (s *Session) answer(conn net.Conn) {
	_ = conn.SetReadDeadline(time.Now().Add(helperHandshakeTimeout))
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return
	}
	var hello helperHello
	if json.Unmarshal(line, &hello) != nil || subtle.ConstantTimeCompare([]byte(hello.Token), []byte(s.token)) != 1 {
		writeReply(conn, helperReply{Status: replyError, Error: "this approval is not open"})
		return
	}
	_ = conn.SetReadDeadline(time.Time{})

	s.asking.Lock()
	defer s.asking.Unlock()
	s.req.Attempt++
	if s.req.Attempt > maxAttempts {
		writeReply(conn, helperReply{Status: replyError, Error: "too many password attempts"})
		return
	}
	// The helper closing its end (sudo gave up) ends the ask too.
	askCtx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	go func() {
		_, _ = io.Copy(io.Discard, conn)
		cancel()
	}()
	password, err := s.approver.Approve(askCtx, s.req)
	switch {
	case err == nil:
		writeReply(conn, helperReply{Status: replyAllowed, Password: password})
	case errors.Is(err, ErrDeclined):
		writeReply(conn, helperReply{Status: replyDeclined})
	case errors.Is(err, ErrTimedOut) || askCtx.Err() != nil:
		writeReply(conn, helperReply{Status: replyTimedOut})
	default:
		writeReply(conn, helperReply{Status: replyError, Error: err.Error()})
	}
}

func writeReply(conn net.Conn, reply helperReply) {
	raw, err := json.Marshal(reply)
	if err != nil {
		return
	}
	_, _ = conn.Write(append(raw, '\n'))
}

// askSession is the helper's side: it reaches the session named in its environment and returns
// the password, or ErrDeclined, ErrTimedOut or why it could not ask.
func askSession() (string, error) {
	socket, token := strings.TrimSpace(getenv(EnvSocket)), strings.TrimSpace(getenv(EnvToken))
	if socket == "" || token == "" {
		return "", fmt.Errorf("started as the askpass helper without an approval session")
	}
	conn, err := net.Dial("unix", socket)
	if err != nil {
		return "", fmt.Errorf("reach the approval session: %w", err)
	}
	defer conn.Close()
	if deadline, err := strconv.ParseInt(strings.TrimSpace(getenv(EnvDeadline)), 10, 64); err == nil && deadline > 0 {
		// A little past the deadline: the session answers "timed out" then.
		_ = conn.SetDeadline(time.Unix(deadline, 0).Add(5 * time.Second))
	}
	hello, _ := json.Marshal(helperHello{Token: token})
	if _, err := conn.Write(append(hello, '\n')); err != nil {
		return "", fmt.Errorf("reach the approval session: %w", err)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return "", ErrTimedOut
		}
		return "", fmt.Errorf("the approval session closed: %w", err)
	}
	var reply helperReply
	if err := json.Unmarshal(line, &reply); err != nil {
		return "", fmt.Errorf("read the approval session's answer: %w", err)
	}
	switch reply.Status {
	case replyAllowed:
		return reply.Password, nil
	case replyDeclined:
		return "", ErrDeclined
	case replyTimedOut:
		return "", ErrTimedOut
	}
	return "", fmt.Errorf("%s", reply.Error)
}

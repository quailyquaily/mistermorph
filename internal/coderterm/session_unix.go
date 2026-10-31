//go:build unix

package coderterm

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	vt "github.com/charmbracelet/x/vt"
	"github.com/creack/pty"
)

const Supported = true

type session struct {
	b                           backend
	cwd, id, dir                string
	transcriptDir, transcriptAt string
	busy                        bool // Guarded by Sessions.mu.
	resumed                     bool // Reopened an earlier conversation.
	prompted                    bool // A task reached the CLI; read after run returns.
	askedID                     bool // Codex: /status was requested to learn the session ID.
	cmd                         *exec.Cmd
	tty                         *os.File
	cancel                      context.CancelFunc
	ctx                         context.Context
	done                        chan struct{}
	inputDone                   chan struct{}
	waitErr                     error
	closeOnce                   sync.Once
	mu                          sync.Mutex // Serializes screen updates, snapshots, and input.
	screen                      *vt.Emulator
}

// start launches the CLI. A non-empty resumeID reopens that session's conversation.
func start(b backend, req Request, resumeID string) (*session, error) {
	root := ""
	if req.LogRoot != "" {
		root = filepath.Join(req.LogRoot, "coder")
		if err := os.MkdirAll(root, 0o700); err != nil {
			return nil, err
		}
	}
	dir, err := os.MkdirTemp(root, "terminal-")
	if err != nil {
		return nil, err
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	env := req.Env
	if env == nil {
		env = os.Environ()
	}
	values := make(map[string]string)
	var childEnv []string
	for _, entry := range env {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[key] = value
		}
		if !strings.HasPrefix(entry, "TERM=") {
			childEnv = append(childEnv, entry)
		}
	}
	home := values["HOME"]
	if home == "" {
		if home, err = os.UserHomeDir(); err != nil {
			return nil, err
		}
	}
	log, err := os.OpenFile(filepath.Join(dir, "terminal.log"), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{b: b, cwd: req.CWD, id: b.newID(), dir: dir, ctx: ctx, cancel: cancel, done: make(chan struct{}), inputDone: make(chan struct{}), screen: vt.NewEmulator(120, 40)}
	if resumeID != "" {
		s.id, s.resumed = resumeID, true
	}
	s.transcriptDir = b.transcriptRoot(func(key string) string { return values[key] }, home, req.CWD)
	s.cmd = exec.CommandContext(ctx, req.Command, b.args(s.id, s.resumed)...)
	s.cmd.Dir = req.CWD
	s.cmd.Env = append(childEnv, "TERM=xterm-256color")
	s.cmd.Cancel = func() error {
		err := syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	s.tty, err = pty.StartWithSize(s.cmd, &pty.Winsize{Cols: 120, Rows: 40})
	if err != nil {
		cancel()
		log.Close()
		s.screen.Close()
		return nil, err
	}
	// The emulator's input pipe carries both terminal replies and user input.
	go func() {
		defer close(s.inputDone)
		_, _ = io.Copy(s.tty, s.screen)
		_ = s.screen.InputPipe().(io.Closer).Close()
	}()
	go func() {
		defer log.Close()
		buf := make([]byte, 32768)
		for {
			n, err := s.tty.Read(buf)
			if n > 0 {
				_, _ = log.Write(buf[:n])
				s.mu.Lock()
				_, _ = s.screen.Write(buf[:n])
				s.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { s.waitErr = s.cmd.Wait(); close(s.done); cancel() }()
	return s, nil
}

func (s *session) exited() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

func (s *session) close() {
	s.closeOnce.Do(func() {
		s.cancel()
		<-s.done
		s.tty.Close()
		// Unblock an emulator write if the input forwarding goroutine exited.
		s.screen.InputPipe().(io.Closer).Close()
		<-s.inputDone
		s.mu.Lock()
		s.screen.Close()
		s.mu.Unlock()
	})
}

func (s *session) snapshot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.screen.String()
}

// findTranscript caches the session file once it exists.
func (s *session) findTranscript() error {
	if s.transcriptAt != "" || s.id == "" {
		return nil
	}
	path, err := s.b.findTranscript(s.transcriptDir, s.id)
	s.transcriptAt = path
	return err
}

// confirmSelection presses Enter once the highlight reaches option, on the same prompt.
func (s *session) confirmSelection(ctx context.Context, fingerprint string, option int) error {
	deadline := time.After(3 * time.Second)
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline:
			return fmt.Errorf("%s did not select option %d", s.b.label(), option+1)
		case <-tick.C:
		}
		v := s.b.parse(s.snapshot())
		if v.question == nil || v.question.Text+fmt.Sprint(v.question.Options) != fingerprint {
			return fmt.Errorf("%s's prompt changed before the choice was confirmed", s.b.label())
		}
		if v.selected == option {
			s.send("\r")
			return nil
		}
	}
}

func (s *session) send(text string) {
	s.mu.Lock()
	s.screen.SendText(text)
	s.mu.Unlock()
}

func (s *session) run(parent context.Context, req Request) (output string, err error) {
	name := s.b.label()
	// Process exit also cancels ctx; report it as an exit unless the caller stopped first.
	defer func() {
		if errors.Is(err, context.Canceled) && parent.Err() == nil && s.exited() {
			err = fmt.Errorf("%s terminal exited: %v (diagnostics: %s)", name, s.waitErr, s.dir)
		}
	}()
	ctx, cancel := context.WithCancel(parent)
	stopCancel := context.AfterFunc(s.ctx, cancel)
	defer cancel()
	defer stopCancel()
	progress := func(text string) {
		if req.Progress != nil {
			req.Progress(text)
		}
	}
	if s.resumed && !s.prompted {
		progress(name + " is resuming the previous session")
	} else {
		progress(name + " is starting")
	}
	expected := "Coding task:\n" + req.Task
	var turn turnReader
	var offset int64
	var sent, declined, idle bool
	var answered string
	pause := func() error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
			return nil
		}
	}
	partial := func() string {
		if turn == nil {
			return ""
		}
		text, _, _ := turn.state()
		return text
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return partial(), ctx.Err()
		case <-s.done:
			return partial(), fmt.Errorf("%s terminal exited: %v (diagnostics: %s)", name, s.waitErr, s.dir)
		case <-tick.C:
		}
		screen := s.snapshot()
		view := s.b.parse(screen)
		if view.problem != "" {
			return "", fmt.Errorf("%s (diagnostics: %s)", view.problem, s.dir)
		}
		if view.rule != "" {
			// The user already chose "don't ask again"; Enter keeps the suggested scope, as in the TUI.
			if answered != "rule:"+view.rule {
				if err := pause(); err != nil {
					return "", err
				}
				s.send("\r")
				answered = "rule:" + view.rule
				progress(name + " will stop asking for: " + view.rule)
			}
			continue
		}
		if view.question != nil {
			fingerprint := view.question.Text + fmt.Sprint(view.question.Options)
			if fingerprint == answered {
				continue
			}
			if req.Ask == nil {
				return "", fmt.Errorf("%s needs a user answer, but this task has no question channel", name)
			}
			progress(name + " is waiting for an answer")
			answer, err := req.Ask(ctx, *view.question)
			if err != nil {
				return "", err
			}
			s.mu.Lock()
			current := s.b.parse(s.screen.String())
			if current.question == nil || current.question.Text+fmt.Sprint(current.question.Options) != fingerprint {
				s.mu.Unlock()
				return "", fmt.Errorf("%s's question changed before the answer arrived", name)
			}
			input, err := current.answer(answer)
			s.mu.Unlock()
			if err != nil {
				return "", err
			}
			if current.immediate {
				// Let the prompt finish rendering before the key.
				if err := pause(); err != nil {
					return "", err
				}
				s.send(input)
				if current.selectThenEnter {
					if err := s.confirmSelection(ctx, fingerprint, answer.Option); err != nil {
						return "", err
					}
				}
			} else if err := s.submit(ctx, input, false); err != nil {
				return "", err
			}
			no, stopNow := s.b.declined(current, answer)
			if stopNow {
				return "", fmt.Errorf("%s permission declined; terminal session closed", name)
			}
			declined = declined || no
			answered = fingerprint
			progress(name + " is working")
			continue
		}
		answered = ""
		wasIdle := idle
		idle = view.idle
		if !sent && s.id == "" {
			// Codex picks its own session ID; /status shows it before any task. Startup can
			// draw an idle frame before the trust prompt, so wait for a second idle tick.
			if id := s.b.sessionID(screen); id != "" {
				s.id = id
			} else if view.idle && wasIdle && !s.askedID {
				err := s.submit(ctx, "/status", false)
				if errors.Is(err, errPromptAppeared) {
					continue // Answer the prompt, then ask again.
				}
				if err != nil {
					return "", err
				}
				s.askedID = true
			}
			continue
		}
		if !sent && view.idle {
			// A resumed session file already holds earlier turns, so start from its end.
			if err := s.findTranscript(); err != nil {
				return "", err
			}
			if s.transcriptAt != "" {
				info, err := os.Stat(s.transcriptAt)
				if err != nil {
					return "", err
				}
				offset = info.Size()
			}
			s.prompted = true
			// A natural-language prefix keeps / and ! from becoming TUI commands.
			if err := s.submit(ctx, expected, true); err != nil {
				return "", err
			}
			sent = true
			progress(name + " is working")
		}
		if !sent {
			continue
		}
		if turn == nil {
			if err := s.findTranscript(); err != nil {
				return "", err
			}
			if s.transcriptAt == "" {
				continue
			}
			turn = s.b.newTurn(s.transcriptAt, offset, expected)
		}
		if err := turn.read(); err != nil {
			return "", err
		}
		text, done, err := turn.state()
		if err != nil {
			if declined {
				return text, fmt.Errorf("%s permission declined; terminal session closed", name)
			}
			return text, err
		}
		if done && s.b.parse(s.snapshot()).idle {
			progress(name + " finished")
			return text, nil
		}
	}
}

// errPromptAppeared stops typing when a prompt replaces the input it was meant for, so the
// remaining keys and Enter never answer a prompt the user has not seen.
var errPromptAppeared = errors.New("a prompt appeared while typing")

// The CLIs update their input state after rendering. Enter in the same write can
// submit the old value, so wait for the terminal to echo input before confirming.
func (s *session) submit(ctx context.Context, text string, paste bool) error {
	onPrompt := s.b.parse(s.snapshot()).question != nil
	promptAppeared := func() bool { return !onPrompt && s.b.parse(s.snapshot()).question != nil }
	inputs := []string{text}
	if !paste {
		// Screen-reader questions accept individual characters, not paste events.
		inputs = nil
		for _, r := range text {
			inputs = append(inputs, string(r))
		}
	}
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for _, input := range inputs {
		s.mu.Lock()
		before := s.screen.String()
		cursor := s.screen.CursorPosition()
		if paste {
			s.screen.Paste(input)
		} else {
			s.screen.SendText(input)
		}
		s.mu.Unlock()
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-tick.C:
			}
			s.mu.Lock()
			cursorNow := s.screen.CursorPosition()
			changed := s.screen.String() != before || cursorNow != cursor
			s.mu.Unlock()
			if promptAppeared() {
				return errPromptAppeared
			}
			if changed {
				break
			}
		}
		// The renderer writes before React installs the updated input handler.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	if promptAppeared() {
		return errPromptAppeared
	}
	s.mu.Lock()
	s.screen.SendText("\r")
	s.mu.Unlock()
	return nil
}

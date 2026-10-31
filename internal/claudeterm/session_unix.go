//go:build unix

package claudeterm

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
	"github.com/google/uuid"
)

const Supported = true

type session struct {
	cwd, id, dir                string
	projectsDir, transcriptPath string
	busy                        bool // Guarded by Sessions.mu.
	resumed                     bool // Started with --resume.
	prompted                    bool // A task reached Claude; read after run returns.
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

// start launches Claude. A non-empty resumeID reopens that session's conversation.
func start(req Request, resumeID string) (*session, error) {
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
	log, err := os.OpenFile(filepath.Join(dir, "terminal.log"), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{cwd: req.CWD, id: uuid.NewString(), dir: dir, ctx: ctx, cancel: cancel, done: make(chan struct{}), inputDone: make(chan struct{}), screen: vt.NewEmulator(120, 40)}
	// --resume keeps the session ID and appends to the same JSONL.
	idFlag := "--session-id"
	if resumeID != "" {
		s.id, s.resumed, idFlag = resumeID, true, "--resume"
	}
	s.cmd = exec.CommandContext(ctx, req.Command, idFlag, s.id, "--ax-screen-reader", "--permission-mode", "default")
	s.cmd.Dir = req.CWD
	env := req.Env
	if env == nil {
		env = os.Environ()
	}
	var configDir, home string
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "CLAUDE_CONFIG_DIR="); ok {
			configDir = value
		}
		if value, ok := strings.CutPrefix(entry, "HOME="); ok {
			home = value
		}
		if !strings.HasPrefix(entry, "TERM=") {
			s.cmd.Env = append(s.cmd.Env, entry)
		}
	}
	if configDir == "" {
		if home == "" {
			home, err = os.UserHomeDir()
			if err != nil {
				cancel()
				log.Close()
				s.screen.Close()
				return nil, err
			}
		}
		configDir = filepath.Join(home, ".claude")
	}
	if !filepath.IsAbs(configDir) {
		configDir = filepath.Join(req.CWD, configDir)
	}
	s.projectsDir = filepath.Join(configDir, "projects")
	s.cmd.Env = append(s.cmd.Env, "TERM=xterm-256color")
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

// Locate only our UUID, without reproducing Claude's project-directory encoding.
// This scan stops once the session file has been created and found.
func (s *session) findTranscript() error {
	entries, err := os.ReadDir(s.projectsDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(s.projectsDir, entry.Name(), s.id+".jsonl")
		if _, err := os.Stat(path); err == nil {
			s.transcriptPath = path
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *session) run(parent context.Context, req Request) (output string, err error) {
	// Process exit also cancels ctx; report it as an exit unless the caller stopped first.
	defer func() {
		if errors.Is(err, context.Canceled) && parent.Err() == nil && s.exited() {
			err = fmt.Errorf("Claude terminal exited: %v (diagnostics: %s)", s.waitErr, s.dir)
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
		progress("Claude is resuming the previous session")
	} else {
		progress("Claude is starting")
	}
	var sent bool
	var answered string
	transcript := transcriptReader{expected: "Coding task:\n" + req.Task, path: s.transcriptPath}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return transcript.assistant, ctx.Err()
		case <-s.done:
			return transcript.assistant, fmt.Errorf("Claude terminal exited: %v (diagnostics: %s)", s.waitErr, s.dir)
		case <-tick.C:
		}
		screen := s.snapshot()
		view := parseScreen(screen)
		if view.problem != "" {
			return "", fmt.Errorf("%s (diagnostics: %s)", view.problem, s.dir)
		}
		if view.rule != "" {
			// The user already chose "don't ask again"; Enter keeps Claude's suggested scope, as in the TUI.
			if answered != "rule:"+view.rule {
				select {
				case <-ctx.Done():
					return "", ctx.Err()
				case <-time.After(100 * time.Millisecond):
				}
				s.mu.Lock()
				s.screen.SendText("\r")
				s.mu.Unlock()
				answered = "rule:" + view.rule
				progress("Claude will stop asking for: " + view.rule)
			}
			continue
		}
		if view.question != nil {
			fingerprint := view.question.Text + fmt.Sprint(view.question.Options)
			if fingerprint == answered {
				continue
			}
			if req.Ask == nil {
				return "", fmt.Errorf("Claude needs a user answer, but this task has no question channel")
			}
			progress("Claude is waiting for an answer")
			answer, err := req.Ask(ctx, *view.question)
			if err != nil {
				return "", err
			}
			s.mu.Lock()
			current := parseScreen(s.screen.String())
			if current.question == nil || current.question.Text+fmt.Sprint(current.question.Options) != fingerprint {
				s.mu.Unlock()
				return "", fmt.Errorf("Claude's question changed before the answer arrived")
			}
			input, err := current.answer(answer)
			s.mu.Unlock()
			if err != nil {
				return "", err
			}
			if err := s.submit(ctx, input, false); err != nil {
				return "", err
			}
			if strings.HasPrefix(current.question.Text, "Permission Required:") && answer.Option >= 0 &&
				(current.question.Options[answer.Option] == "No" || current.keys[answer.Option] == "n") {
				return "", fmt.Errorf("Claude permission declined; terminal session closed")
			}
			answered = fingerprint
			progress("Claude is working")
			continue
		}
		answered = ""
		if !sent && view.idle {
			// A resumed JSONL already holds earlier turns, so locate it before submitting.
			if transcript.path == "" {
				if err := s.findTranscript(); err != nil {
					return "", err
				}
				transcript.path = s.transcriptPath
			}
			if transcript.path != "" {
				info, err := os.Stat(transcript.path)
				if err != nil {
					return "", err
				}
				transcript.offset = info.Size()
			}
			s.prompted = true
			// A natural-language prefix keeps / and ! from becoming TUI commands.
			if err := s.submit(ctx, "Coding task:\n"+req.Task, true); err != nil {
				return "", err
			}
			sent = true
			progress("Claude is working")
		}
		if !sent {
			continue
		}
		if transcript.path == "" {
			if err := s.findTranscript(); err != nil {
				return "", err
			}
			transcript.path = s.transcriptPath
			if transcript.path == "" {
				continue
			}
		}
		if err := transcript.read(); err != nil {
			return "", err
		}
		if transcript.failure != "" {
			return "", fmt.Errorf("Claude: %s", transcript.failure)
		}
		if transcript.complete && parseScreen(s.snapshot()).idle {
			progress("Claude finished")
			if strings.TrimSpace(transcript.assistant) == "" {
				// A turn can end on thinking alone; an empty result reads as lost output.
				return noTextReply, nil
			}
			return transcript.assistant, nil
		}
	}
}

// Claude updates its input state after rendering. Enter in the same write can
// submit the old value, so wait for the terminal to echo input before confirming.
func (s *session) submit(ctx context.Context, text string, paste bool) error {
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
	s.mu.Lock()
	s.screen.SendText("\r")
	s.mu.Unlock()
	return nil
}

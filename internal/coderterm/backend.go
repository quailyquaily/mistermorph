package coderterm

import (
	"fmt"
	"path/filepath"
	"strings"
)

// screenView is what a backend recognized on the current screen.
type screenView struct {
	idle     bool
	question *Question
	keys     []string // The input that selects each option.
	problem  string
	rule     string // Claude: a prefilled permission rule waiting for Enter.
	// immediate means a single key answers; otherwise text is typed and Enter submits.
	immediate bool
	// selectThenEnter: the key only moves the highlight to selected; Enter confirms.
	selectThenEnter bool
	selected        int
}

func (v screenView) answer(a Answer) (string, error) {
	if a.Option < 0 {
		if v.question.ChoicesOnly {
			return "", fmt.Errorf("this prompt requires an option")
		}
		if err := checkText(a.Text); err != nil {
			return "", err
		}
		return strings.NewReplacer("\n", " ", "\r", " ", "\t", " ").Replace(a.Text), nil
	}
	if a.Option >= len(v.keys) {
		return "", fmt.Errorf("option %d is not available", a.Option+1)
	}
	return v.keys[a.Option], nil
}

// backend holds what differs between the coding CLIs. The terminal, input, questions,
// and session bookkeeping are shared.
type backend interface {
	// label names the CLI in status lines and errors.
	label() string
	// newID returns the session ID to start with, or "" when the CLI picks its own.
	newID() string
	// args returns the command-line arguments. resume reopens id's conversation.
	args(id string, resume bool) []string
	// transcriptRoot returns the directory holding session files, from the child's environment.
	transcriptRoot(getenv func(string) string, home, cwd string) string
	// findTranscript returns the session file for id under root, or "" before it exists.
	findTranscript(root, id string) (string, error)
	parse(screen string) screenView
	// sessionID reads the session ID from the screen, for CLIs that pick their own.
	sessionID(screen string) string
	// newTurn reads the turn that submits expected, from offset onward.
	newTurn(path string, offset int64, expected string) turnReader
	// declined reports whether answer a declines a permission. stopNow ends the call at once,
	// for a CLI that does not record the end of a declined turn.
	declined(view screenView, a Answer) (declined, stopNow bool)
}

// turnReader follows one submitted task through the session file.
type turnReader interface {
	read() error
	// state reports text so far, whether the turn finished, and why it failed.
	state() (output string, done bool, err error)
}

func backendFor(name string) (backend, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "claude":
		return claudeBackend{}, nil
	case "codex":
		return codexBackend{}, nil
	default:
		return nil, fmt.Errorf("unsupported coder terminal: %q", name)
	}
}

// configDir resolves a CLI's config directory from an env override or the home default.
func configDir(getenv func(string) string, key, home, fallback, cwd string) string {
	dir := getenv(key)
	if dir == "" {
		dir = filepath.Join(home, fallback)
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(cwd, dir)
	}
	return dir
}

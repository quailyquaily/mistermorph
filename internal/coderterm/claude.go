package coderterm

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// claudeBackend drives Claude Code's screen-reader layout and reads projects/*/<id>.jsonl.
type claudeBackend struct{}

func (claudeBackend) label() string { return "Claude" }

// Claude takes the session ID on the command line, so the transcript can be found by name.
func (claudeBackend) newID() string { return uuid.NewString() }

func (claudeBackend) args(id string, resume bool) []string {
	// --resume keeps the session ID and appends to the same JSONL.
	flag := "--session-id"
	if resume {
		flag = "--resume"
	}
	return []string{flag, id, "--ax-screen-reader", "--permission-mode", "default"}
}

func (claudeBackend) transcriptRoot(getenv func(string) string, home, cwd string) string {
	return filepath.Join(configDir(getenv, "CLAUDE_CONFIG_DIR", home, ".claude", cwd), "projects")
}

// Locate only our UUID, without reproducing Claude's project-directory encoding.
func (claudeBackend) findTranscript(root, id string) (string, error) {
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(root, entry.Name(), id+".jsonl")
		if _, err := os.Stat(path); err == nil {
			return path, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	return "", nil
}

func (claudeBackend) parse(screen string) screenView { return parseClaudeScreen(screen) }

func (claudeBackend) sessionID(string) string { return "" }

func (claudeBackend) newTurn(path string, offset int64, expected string) turnReader {
	return &claudeTranscript{path: path, offset: offset, expected: expected}
}

// The CLI's decline path does not always record the end of the turn, so it stops at once.
func (claudeBackend) declined(view screenView, a Answer) (bool, bool) {
	q := view.question
	no := strings.HasPrefix(q.Text, "Permission Required:") && a.Option >= 0 && a.Option < len(q.Options) &&
		(q.Options[a.Option] == "No" || view.keys[a.Option] == "n")
	return no, no
}

func (r *claudeTranscript) state() (string, bool, error) {
	if r.failure != "" {
		return r.assistant, false, fmt.Errorf("Claude: %s", r.failure)
	}
	if r.complete && strings.TrimSpace(r.assistant) == "" {
		// A turn can end on thinking alone; an empty result reads as lost output.
		return noTextReply, true, nil
	}
	return r.assistant, r.complete, nil
}

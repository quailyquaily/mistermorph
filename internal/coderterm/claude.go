package coderterm

import (
	"encoding/json"
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

// StatusLineFile is where a Claude terminal's status line command keeps the status JSON Claude
// Code gives it (its subscription's rate limits among it), in the session's folder.
const StatusLineFile = "statusline.json"

func (claudeBackend) args(id string, resume, bypass bool, dir string) []string {
	// --resume keeps the session ID and appends to the same JSONL.
	flag := "--session-id"
	if resume {
		flag = "--resume"
	}
	// --settings applies to this process only and leaves the user's files alone.
	settings := map[string]any{}
	if dir != "" {
		// Claude Code hands its status line command the session's status as JSON, the
		// subscription's 5-hour and weekly limits included; the command keeps it and prints
		// nothing, so the screen this reader parses is unchanged.
		settings["statusLine"] = map[string]any{
			"type":    "command",
			"command": "cat > " + shellQuote(filepath.Join(dir, StatusLineFile)),
			"padding": 0,
		}
	}
	if bypass {
		// Every tool runs without a permission prompt. The user opted in through config, so
		// skip Claude's one-time Bypass Permissions warning, which this screen reader does not
		// answer.
		settings["skipDangerousModePermissionPrompt"] = true
	}
	args := []string{flag, id, "--ax-screen-reader"}
	if bypass {
		args = append(args, "--dangerously-skip-permissions")
	} else {
		args = append(args, "--permission-mode", "default")
	}
	if len(settings) > 0 {
		// Unescaped, so the command reads as written in ps and the logs.
		var data strings.Builder
		enc := json.NewEncoder(&data)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(settings)
		args = append(args, "--settings", strings.TrimSpace(data.String()))
	}
	return args
}

// shellQuote quotes s for a POSIX shell.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
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

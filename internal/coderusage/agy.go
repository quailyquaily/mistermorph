package coderusage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"
)

// AgyReadTimeout bounds a quota read: the Antigravity CLI starting and answering /usage.
const AgyReadTimeout = 30 * time.Second

// agyWarnUsedPercent is the share used from which a window counts as nearly used up. The CLI
// gives no warning of its own; 90% is where the Console's bars turn red.
const agyWarnUsedPercent = 90

// ErrAgySignIn says the Antigravity CLI has no sign-in to run with. Headless, it prints a sign-in
// link and waits a minute for it; nothing here waits that out.
var ErrAgySignIn = errors.New("agy is not signed in: run `agy` once in a terminal and sign in with a Google account, then try again")

// IsAgyAuthPrompt reports whether a line of the CLI's stderr is its sign-in prompt
// ("Authentication required. Please visit the URL to log in:", "Waiting for authentication …").
func IsAgyAuthPrompt(line string) bool {
	line = strings.ToLower(line)
	return strings.Contains(line, "authentication required") || strings.Contains(line, "waiting for authentication")
}

// IsAgyAuthError reports whether a result's error is the failed sign-in
// ("authentication failed or timed out", "authentication required").
func IsAgyAuthError(message string) bool {
	message = strings.ToLower(message)
	return strings.Contains(message, "authentication failed") || strings.Contains(message, "authentication required") ||
		strings.Contains(message, "authentication interrupted")
}

// AgyUsage reads a `usage` object of the Antigravity CLI's stream (on a finished agent_response
// step and on `result`): input_tokens, output_tokens, thinking_tokens, cache_read_tokens.
//
// The CLI's input_tokens does not count cached reads: a real two-call run (agy 1.5.9) reported
// 8651 input and 0 cached for its first call, and 2355 input with 6612 cached for the second, whose
// prompt was the first one and a tool's output, with total_tokens 2547 = 2355 + 192 output. So the
// cached reads are added here, as llmstats counts every input token. output_tokens includes
// thinking_tokens (a run that answered "ok": 99 output, 98 thinking), as Codex's output includes
// its reasoning tokens.
func AgyUsage(usage map[string]any) ModelUsage {
	cached := intField(usage, "cache_read_tokens")
	return ModelUsage{
		Model:             BackendAgy,
		InputTokens:       intField(usage, "input_tokens") + cached,
		CachedInputTokens: cached,
		OutputTokens:      intField(usage, "output_tokens"),
		ReasoningTokens:   intField(usage, "thinking_tokens"),
	}
}

// agyUsageEnvelope is the part of `agy -p /usage --output-format json` read here. The CLI answers
// the command itself (no model, no tokens) and gives the quota as data.
type agyUsageEnvelope struct {
	Status  string `json:"status"`
	Error   string `json:"error"`
	Command struct {
		Name string `json:"name"`
		Data struct {
			Groups []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
				Buckets     []struct {
					ID                string   `json:"id"`
					Name              string   `json:"name"`
					Window            string   `json:"window"`
					RemainingFraction *float64 `json:"remaining_fraction"`
					ResetTime         string   `json:"reset_time"`
				} `json:"buckets"`
			} `json:"groups"`
		} `json:"data"`
	} `json:"command"`
}

// ParseAgyUsage reads the quota from the Antigravity CLI's /usage JSON: a window per bucket of
// each model group, in the CLI's order of groups, the shorter windows of a group first. The CLI
// says what remains of a window; used is 1 - remaining_fraction. A window with nothing left is
// rejected, one from 90% used a warning. The quota's own status is the best of its groups': one
// group at its limit leaves the models of the others usable, so the quota is rejected only when
// every group is, and a warning when any group is near or at a limit.
func ParseAgyUsage(data []byte, now time.Time) (Quota, error) {
	var parsed agyUsageEnvelope
	if err := json.Unmarshal(bytes.TrimSpace(data), &parsed); err != nil {
		return Quota{}, fmt.Errorf("agy /usage: %w", err)
	}
	if status := strings.TrimSpace(parsed.Status); status != "" && status != "SUCCESS" {
		if IsAgyAuthError(parsed.Error) {
			return Quota{}, ErrAgySignIn
		}
		return Quota{}, fmt.Errorf("agy /usage: %s", firstNonEmpty(firstLine(parsed.Error), status))
	}
	q := Quota{Backend: BackendAgy, ObservedAt: now.UTC().Format(time.RFC3339), Source: SourceRead}
	groupStatuses := []string{}
	for _, group := range parsed.Command.Data.Groups {
		name := strings.TrimSpace(group.Name)
		var windows []Window
		for _, bucket := range group.Buckets {
			id := strings.TrimSpace(bucket.ID)
			w := Window{
				Kind:          firstNonEmpty(id, strings.TrimSpace(name+" "+bucket.Window)),
				Group:         name,
				WindowMinutes: agyWindowMinutes(bucket.Window, id),
				Status:        StatusAllowed,
			}
			if w.Kind == "" {
				continue
			}
			if bucket.RemainingFraction != nil && !math.IsNaN(*bucket.RemainingFraction) {
				w.UsedPercent = percent((1 - *bucket.RemainingFraction) * 100)
				switch {
				case *bucket.RemainingFraction <= 0:
					w.Status = StatusRejected
				case *w.UsedPercent >= agyWarnUsedPercent:
					w.Status = StatusWarning
				}
			}
			if reset, err := time.Parse(time.RFC3339, strings.TrimSpace(bucket.ResetTime)); err == nil {
				w.ResetsAt = reset.UTC().Format(time.RFC3339)
			}
			windows = append(windows, w)
		}
		if len(windows) == 0 {
			continue
		}
		sortWindows(windows)
		q.Windows = append(q.Windows, windows...)
		q.Groups = append(q.Groups, Group{Name: name, Models: agyGroupModels(group.Description)})
		groupStatuses = append(groupStatuses, worstStatus(windows))
	}
	if len(q.Windows) == 0 {
		return Quota{}, fmt.Errorf("agy /usage: no quota reported")
	}
	q.Status = StatusRejected
	for _, status := range groupStatuses {
		if status != StatusRejected {
			q.Status = StatusAllowed
		}
	}
	if q.Status == StatusAllowed && worstStatus(q.Windows) != StatusAllowed {
		q.Status = StatusWarning
	}
	return q, nil
}

// agyWindowMinutes is a bucket's length from its `window` ("weekly" is the only one seen; the
// docs name a five-hour limit without giving its word), else from its id; 0 when neither says.
func agyWindowMinutes(window, id string) int64 {
	for _, raw := range []string{window, id} {
		text := strings.NewReplacer("-", "", "_", "", " ", "").Replace(strings.ToLower(raw))
		switch {
		case text == "":
			continue
		case strings.Contains(text, "week") || strings.Contains(text, "7d") || strings.Contains(text, "sevenday"):
			return 10080
		case strings.Contains(text, "fivehour") || strings.Contains(text, "5h"):
			return 300
		case strings.Contains(text, "daily") || strings.Contains(text, "24h"):
			return 1440
		}
	}
	return 0
}

// agyGroupModels reads a group's models from its description
// ("Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B").
func agyGroupModels(description string) []string {
	_, list, ok := strings.Cut(description, ":")
	if !ok || !strings.Contains(strings.ToLower(description), "models within this group") {
		return nil
	}
	var models []string
	for _, model := range strings.Split(list, ",") {
		if model = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(model), ".")); model != "" {
			models = append(models, model)
		}
	}
	return models
}

// ReadAgyQuota asks the Antigravity CLI for its subscription quota: `agy -p /usage --output-format
// json`, which the CLI answers itself (no model, no tokens, no conversation saved). command is the
// agy executable; env, when not nil, its environment. When the CLI is not signed in it prints a
// sign-in prompt and would wait a minute: the read stops at the prompt with ErrAgySignIn.
func ReadAgyQuota(ctx context.Context, command string, env []string) (Quota, error) {
	if strings.TrimSpace(command) == "" {
		return Quota{}, fmt.Errorf("agy executable not found")
	}
	ctx, cancel := context.WithTimeout(ctx, AgyReadTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, "-p", "/usage", "--output-format", "json")
	if env != nil {
		cmd.Env = env
	}
	// The read is about the account, not a folder.
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	} else {
		cmd.Dir = os.TempDir()
	}
	cmd.WaitDelay = time.Second
	var stdout, stderr bytes.Buffer
	var signIn atomic.Bool
	cmd.Stdout = &limitedWriter{buf: &stdout, limit: 1 << 20}
	cmd.Stderr = &agyAuthWatcher{next: &limitedWriter{buf: &stderr, limit: 4096}, found: func() {
		signIn.Store(true)
		cancel()
	}}
	err := cmd.Run()
	if signIn.Load() {
		return Quota{}, ErrAgySignIn
	}
	// A failed run still prints its envelope, with the reason.
	if out := bytes.TrimSpace(stdout.Bytes()); len(out) > 0 && (err == nil || json.Valid(out)) {
		return ParseAgyUsage(out, time.Now())
	}
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return Quota{}, fmt.Errorf("agy /usage did not answer in %s", AgyReadTimeout)
		}
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			return Quota{}, fmt.Errorf("agy /usage: %w: %s", err, detail)
		}
		return Quota{}, fmt.Errorf("agy /usage: %w", err)
	}
	return Quota{}, fmt.Errorf("agy /usage: no output")
}

// agyAuthWatcher passes stderr on until the CLI's sign-in prompt, then calls found once and drops
// the rest: the sign-in link that follows is of no use to a run that is being stopped.
type agyAuthWatcher struct {
	next  *limitedWriter
	found func()
	seen  bool
	tail  string
}

func (w *agyAuthWatcher) Write(p []byte) (int, error) {
	if w.seen {
		return len(p), nil
	}
	// The prompt can be split over writes: keep the end of the last one.
	text := w.tail + string(p)
	if IsAgyAuthPrompt(text) {
		w.seen = true
		w.found()
		return len(p), nil
	}
	if len(text) > 64 {
		text = text[len(text)-64:]
	}
	w.tail = text
	return w.next.Write(p)
}

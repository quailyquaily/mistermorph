package coderusage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ClaudeReadTimeout bounds a quota read: Claude Code starting and answering /usage.
const ClaudeReadTimeout = 30 * time.Second

// ReadClaudeQuota asks Claude Code for its subscription usage: `claude -p /usage`, a local command
// that calls no model and uses no quota, without saving a session. command is the claude
// executable; env, when not nil, its environment.
func ReadClaudeQuota(ctx context.Context, command string, env []string) (Quota, error) {
	if strings.TrimSpace(command) == "" {
		return Quota{}, fmt.Errorf("claude executable not found")
	}
	ctx, cancel := context.WithTimeout(ctx, ClaudeReadTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, "-p", "/usage", "--output-format", "json", "--no-session-persistence")
	if env != nil {
		cmd.Env = env
	}
	// The read is about the account, not a folder: it runs in the home folder (Claude Code keeps
	// a project folder for where it runs, and the home folder's is likely there already).
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	} else {
		cmd.Dir = os.TempDir()
	}
	cmd.WaitDelay = time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, limit: 1 << 20}
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: 4096}
	if err := cmd.Run(); err != nil {
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			return Quota{}, fmt.Errorf("claude /usage: %w: %s", err, detail)
		}
		return Quota{}, fmt.Errorf("claude /usage: %w", err)
	}
	var result struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); err != nil {
		return Quota{}, fmt.Errorf("claude /usage: %w", err)
	}
	if result.IsError {
		return Quota{}, fmt.Errorf("claude /usage: %s", firstLine(result.Result))
	}
	return ParseClaudeUsage(result.Result, time.Now())
}

// claudeUsageLine is one limit of /usage: "Current session: 70% used · resets Nov 14, 12:10am
// (Asia/Tokyo)", "Current week (all models): 12% used · …", "Current week (Fable): 14% used · …".
var claudeUsageLine = regexp.MustCompile(`^Current (session|week \(([^)]+)\)):\s*([0-9]+(?:\.[0-9]+)?)% used(?:\s*·\s*resets\s+(.+))?$`)

// ParseClaudeUsage reads the limits of Claude Code's /usage text: the session (the 5-hour window),
// the week for all models, and a week of one model ("seven_day_fable"). The rest of the text (what
// contributed to the usage) is left. It fails when the text has no limit, as with an API key.
func ParseClaudeUsage(text string, now time.Time) (Quota, error) {
	q := Quota{Backend: BackendClaude, ObservedAt: now.UTC().Format(time.RFC3339), Source: SourceRead}
	for _, line := range strings.Split(text, "\n") {
		m := claudeUsageLine.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		kind := "five_hour"
		if m[1] != "session" {
			kind = "seven_day"
			if model := strings.TrimSpace(m[2]); !strings.EqualFold(model, "all models") {
				kind += "_" + strings.ToLower(strings.Join(strings.Fields(model), "_"))
			}
		}
		used, err := strconv.ParseFloat(m[3], 64)
		if err != nil {
			continue
		}
		w := Window{Kind: kind, WindowMinutes: claudeKindMinutes(kind), UsedPercent: percent(used), Status: StatusAllowed}
		if used >= 100 {
			w.Status = StatusRejected
		}
		if reset, ok := parseClaudeReset(m[4], now); ok {
			w.ResetsAt = reset.UTC().Format(time.RFC3339)
		}
		q.Windows = append(q.Windows, w)
	}
	if len(q.Windows) == 0 {
		return Quota{}, fmt.Errorf("claude /usage reported no subscription limits: %s", firstLine(text))
	}
	sortWindows(q.Windows)
	q.Status = worstStatus(q.Windows)
	return q, nil
}

// claudeReset is a /usage reset time: "Nov 14, 12:10am (Asia/Tokyo)", "Nov 20, 5am (Asia/Tokyo)",
// or a time alone for today ("5pm (Asia/Tokyo)").
var claudeReset = regexp.MustCompile(`^(?:([A-Z][a-z]{2}) ([0-9]{1,2}),?\s+)?([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)\s*\(([^)]+)\)$`)

// parseClaudeReset reads a reset time in its time zone. The text has no year: it is the next such
// time, not more than a day in the past.
func parseClaudeReset(text string, now time.Time) (time.Time, bool) {
	m := claudeReset.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return time.Time{}, false
	}
	loc, err := time.LoadLocation(strings.TrimSpace(m[6]))
	if err != nil {
		return time.Time{}, false
	}
	hour, _ := strconv.Atoi(m[3])
	minute := 0
	if m[4] != "" {
		minute, _ = strconv.Atoi(m[4])
	}
	if hour < 1 || hour > 12 || minute > 59 {
		return time.Time{}, false
	}
	hour %= 12
	if m[5] == "pm" {
		hour += 12
	}
	local := now.In(loc)
	if m[1] == "" {
		at := time.Date(local.Year(), local.Month(), local.Day(), hour, minute, 0, 0, loc)
		if at.Before(now) {
			at = at.AddDate(0, 0, 1)
		}
		return at, true
	}
	month, err := time.Parse("Jan", m[1])
	if err != nil {
		return time.Time{}, false
	}
	day, _ := strconv.Atoi(m[2])
	at := time.Date(local.Year(), month.Month(), day, hour, minute, 0, 0, loc)
	if at.Before(now.Add(-24 * time.Hour)) {
		at = at.AddDate(1, 0, 0)
	}
	return at, true
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	return strings.TrimSpace(line)
}

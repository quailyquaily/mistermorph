package coderusage

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// Quota statuses: within the limits, near one (Claude Code's warning), or at one.
const (
	StatusAllowed  = "allowed"
	StatusWarning  = "allowed_warning"
	StatusRejected = "rejected"
)

// Where a quota came from: a coder run's own events, or a read of the CLI's app server.
const (
	SourceRun  = "run"
	SourceRead = "read"
)

// Window is one of a subscription's usage windows: the 5-hour one, the weekly one.
type Window struct {
	// Kind is the CLI's name for it: Claude Code's "five_hour", "seven_day", …; Codex's "primary"
	// or "secondary".
	Kind string `json:"kind"`
	// WindowMinutes is its length (300, 10080), 0 when unknown.
	WindowMinutes int64 `json:"window_minutes,omitempty"`
	// UsedPercent is how much of it is used, 0–100; nil when the CLI did not say.
	UsedPercent *float64 `json:"used_percent,omitempty"`
	// ResetsAt is when it starts again (RFC 3339), "" when unknown.
	ResetsAt string `json:"resets_at,omitempty"`
	Status   string `json:"status,omitempty"`
}

// Quota is a coder's subscription quota as last reported.
type Quota struct {
	Backend    string   `json:"backend"`
	Plan       string   `json:"plan,omitempty"`
	Status     string   `json:"status,omitempty"`
	Windows    []Window `json:"windows"`
	ObservedAt string   `json:"observed_at"`
	Source     string   `json:"source"`
}

// Observed is when the quota was reported (the zero time when unknown).
func (q Quota) Observed() time.Time {
	t, _ := time.Parse(time.RFC3339, q.ObservedAt)
	return t
}

// claudeWindowMinutes are the lengths of Claude Code's named windows.
var claudeWindowMinutes = map[string]int64{
	"five_hour": 300,
	"seven_day": 10080,
}

// claudeKindMinutes is the length of a Claude Code window by its kind: a model's own week
// ("seven_day_opus", "seven_day_fable") is a week too. 0 when unknown.
func claudeKindMinutes(kind string) int64 {
	if minutes, ok := claudeWindowMinutes[kind]; ok {
		return minutes
	}
	for base, minutes := range claudeWindowMinutes {
		if strings.HasPrefix(kind, base+"_") {
			return minutes
		}
	}
	return 0
}

// ParseClaudeRateLimit reads a Claude Code `rate_limit_event`'s `rate_limit_info`: every window in
// `unifiedWindows` (utilization 0–1), else the one window the event names.
func ParseClaudeRateLimit(info map[string]any, now time.Time) (Quota, bool) {
	if info == nil {
		return Quota{}, false
	}
	q := Quota{
		Backend:    BackendClaude,
		Status:     normalizeStatus(stringValue(info["status"])),
		ObservedAt: now.UTC().Format(time.RFC3339),
		Source:     SourceRun,
	}
	if windows, ok := info["unifiedWindows"].(map[string]any); ok {
		for kind, raw := range windows {
			window, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			w := Window{
				Kind:          strings.TrimSpace(kind),
				WindowMinutes: claudeKindMinutes(strings.TrimSpace(kind)),
				ResetsAt:      unixTime(window["resetsAt"]),
				Status:        normalizeStatus(stringValue(window["status"])),
			}
			if used, ok := window["utilization"].(float64); ok && !math.IsNaN(used) {
				w.UsedPercent = percent(used * 100)
			}
			q.Windows = append(q.Windows, w)
		}
	}
	if len(q.Windows) == 0 {
		kind := strings.TrimSpace(stringValue(info["rateLimitType"]))
		if kind == "" {
			return Quota{}, false
		}
		w := Window{Kind: kind, WindowMinutes: claudeKindMinutes(kind), ResetsAt: unixTime(info["resetsAt"]), Status: q.Status}
		if used, ok := info["utilization"].(float64); ok && !math.IsNaN(used) {
			w.UsedPercent = percent(used * 100)
		}
		q.Windows = append(q.Windows, w)
	}
	sortWindows(q.Windows)
	// The event's own status names the window it is about; a window nearer its limit wins.
	q.Status = worse(q.Status, worstStatus(q.Windows))
	return q, true
}

// claudeStatusLine is the part of the status JSON Claude Code gives a status line command that is
// read here: the subscription's windows, each its share used (0–100) and when it resets (Unix
// seconds). Claude Code includes a window only while its reset has not passed.
type claudeStatusLine struct {
	RateLimits map[string]*struct {
		UsedPercentage *float64 `json:"used_percentage"`
		ResetsAt       float64  `json:"resets_at"`
	} `json:"rate_limits"`
}

// ParseClaudeStatusLine reads the quota from Claude Code's status line JSON (a terminal session's
// StatusLineFile): its `rate_limits` five_hour and seven_day windows. A gateway's spend_limit is
// not a subscription window and is left out. It reports false when there is no window.
func ParseClaudeStatusLine(data []byte, now time.Time) (Quota, bool) {
	var parsed claudeStatusLine
	if err := json.Unmarshal(data, &parsed); err != nil {
		return Quota{}, false
	}
	q := Quota{Backend: BackendClaude, ObservedAt: now.UTC().Format(time.RFC3339), Source: SourceRun}
	for kind, window := range parsed.RateLimits {
		minutes, known := claudeWindowMinutes[kind]
		if window == nil || !known {
			continue
		}
		w := Window{Kind: kind, WindowMinutes: minutes, ResetsAt: unixTime(window.ResetsAt), Status: StatusAllowed}
		if window.UsedPercentage != nil {
			w.UsedPercent = percent(*window.UsedPercentage)
			if *window.UsedPercentage >= 100 {
				w.Status = StatusRejected
			}
		}
		q.Windows = append(q.Windows, w)
	}
	if len(q.Windows) == 0 {
		return Quota{}, false
	}
	sortWindows(q.Windows)
	q.Status = worstStatus(q.Windows)
	return q, true
}

// codexRateLimits is the part of the Codex app server's `account/rateLimits/read` result read here.
type codexRateLimits struct {
	OrdinaryUsageAllowed *bool `json:"ordinaryUsageAllowed"`
	RateLimits           struct {
		PlanType             string       `json:"planType"`
		Primary              *codexWindow `json:"primary"`
		Secondary            *codexWindow `json:"secondary"`
		RateLimitReachedType string       `json:"rateLimitReachedType"`
	} `json:"rateLimits"`
}

type codexWindow struct {
	UsedPercent        float64 `json:"usedPercent"`
	WindowDurationMins int64   `json:"windowDurationMins"`
	ResetsAt           int64   `json:"resetsAt"`
}

// ParseCodexRateLimits reads the Codex app server's `account/rateLimits/read` result.
func ParseCodexRateLimits(result json.RawMessage, now time.Time) (Quota, error) {
	var parsed codexRateLimits
	if err := json.Unmarshal(result, &parsed); err != nil {
		return Quota{}, fmt.Errorf("codex rate limits: %w", err)
	}
	q := Quota{
		Backend:    BackendCodex,
		Plan:       strings.TrimSpace(parsed.RateLimits.PlanType),
		Status:     StatusAllowed,
		ObservedAt: now.UTC().Format(time.RFC3339),
		Source:     SourceRead,
	}
	for kind, window := range map[string]*codexWindow{"primary": parsed.RateLimits.Primary, "secondary": parsed.RateLimits.Secondary} {
		if window == nil {
			continue
		}
		w := Window{Kind: kind, WindowMinutes: max(window.WindowDurationMins, 0), UsedPercent: percent(window.UsedPercent)}
		if window.ResetsAt > 0 {
			w.ResetsAt = time.Unix(window.ResetsAt, 0).UTC().Format(time.RFC3339)
		}
		w.Status = StatusAllowed
		if window.UsedPercent >= 100 {
			w.Status = StatusRejected
		}
		q.Windows = append(q.Windows, w)
	}
	sortWindows(q.Windows)
	if strings.TrimSpace(parsed.RateLimits.RateLimitReachedType) != "" ||
		(parsed.OrdinaryUsageAllowed != nil && !*parsed.OrdinaryUsageAllowed) {
		q.Status = StatusRejected
	} else {
		q.Status = worstStatus(q.Windows)
	}
	if len(q.Windows) == 0 && q.Plan == "" {
		return Quota{}, fmt.Errorf("codex rate limits: no windows reported")
	}
	return q, nil
}

// Note is the quota in a line for the agent and the activity, e.g.
// "claude quota: 5h 12% used (resets in 3h10m), 7d 2% used (resets in 5d 4h)".
func (q Quota) Note(now time.Time) string {
	if len(q.Windows) == 0 {
		return ""
	}
	parts := make([]string, 0, len(q.Windows))
	for _, w := range q.Windows {
		text := WindowLabel(w)
		if w.UsedPercent != nil {
			text += fmt.Sprintf(" %.0f%% used", *w.UsedPercent)
		}
		if w.Status == StatusRejected {
			text += " (limit reached)"
		}
		if reset, err := time.Parse(time.RFC3339, w.ResetsAt); err == nil && reset.After(now) {
			text += " (resets in " + shortDuration(reset.Sub(now)) + ")"
		}
		parts = append(parts, text)
	}
	note := q.Backend + " quota: " + strings.Join(parts, ", ")
	if q.Status == StatusRejected {
		note += "; the limit is reached"
	}
	return note
}

// WindowLabel names a window by its length, and a model's own window by its model too: "5h",
// "7d", "7d opus", "7d fable".
func WindowLabel(w Window) string {
	label := w.Kind
	switch {
	case w.WindowMinutes > 0 && w.WindowMinutes%1440 == 0:
		label = fmt.Sprintf("%dd", w.WindowMinutes/1440)
	case w.WindowMinutes > 0 && w.WindowMinutes%60 == 0:
		label = fmt.Sprintf("%dh", w.WindowMinutes/60)
	case w.WindowMinutes > 0:
		label = fmt.Sprintf("%dm", w.WindowMinutes)
	}
	if model := windowModel(w.Kind); model != "" && w.WindowMinutes > 0 {
		label += " " + model
	}
	return label
}

// windowModel is the model a window is for, from its kind ("seven_day_opus": "opus"), "" for a
// window of every model.
func windowModel(kind string) string {
	for base := range claudeWindowMinutes {
		if rest, ok := strings.CutPrefix(kind, base+"_"); ok {
			return strings.ReplaceAll(rest, "_", " ")
		}
	}
	return ""
}

func shortDuration(d time.Duration) string {
	d = d.Round(time.Minute)
	days := int(d / (24 * time.Hour))
	hours := int(d % (24 * time.Hour) / time.Hour)
	minutes := int(d % time.Hour / time.Minute)
	switch {
	case days > 0 && hours > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case days > 0:
		return fmt.Sprintf("%dd", days)
	case hours > 0 && minutes > 0:
		return fmt.Sprintf("%dh%02dm", hours, minutes)
	case hours > 0:
		return fmt.Sprintf("%dh", hours)
	default:
		return fmt.Sprintf("%dm", max(minutes, 1))
	}
}

// sortWindows puts the shorter windows first.
func sortWindows(windows []Window) {
	sort.SliceStable(windows, func(i, j int) bool {
		a, b := windows[i].WindowMinutes, windows[j].WindowMinutes
		if a != b {
			if a == 0 {
				return false
			}
			if b == 0 {
				return true
			}
			return a < b
		}
		return windows[i].Kind < windows[j].Kind
	})
}

func worstStatus(windows []Window) string {
	status := StatusAllowed
	for _, w := range windows {
		switch w.Status {
		case StatusRejected:
			return StatusRejected
		case StatusWarning:
			status = StatusWarning
		}
	}
	return status
}

var statusRank = map[string]int{"": 0, StatusAllowed: 1, StatusWarning: 2, StatusRejected: 3}

func worse(a, b string) string {
	if statusRank[b] > statusRank[a] {
		return b
	}
	return a
}

func normalizeStatus(raw string) string {
	switch strings.TrimSpace(raw) {
	case "allowed":
		return StatusAllowed
	case "allowed_warning":
		return StatusWarning
	case "rejected":
		return StatusRejected
	}
	return ""
}

func percent(value float64) *float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	value = math.Round(math.Max(0, math.Min(100, value))*10) / 10
	return &value
}

func unixTime(raw any) string {
	seconds, ok := raw.(float64)
	if !ok || seconds <= 0 {
		return ""
	}
	return time.Unix(int64(seconds), 0).UTC().Format(time.RFC3339)
}

func stringValue(raw any) string {
	s, _ := raw.(string)
	return strings.TrimSpace(s)
}

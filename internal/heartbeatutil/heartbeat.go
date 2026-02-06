package heartbeatutil

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/memory"
)

const (
	heartbeatFailureThreshold = 3
)

var heartbeatHTMLComment = regexp.MustCompile(`(?s)<!--.*?-->`)

func FormatFinalOutput(final *agent.Final) string {
	if final == nil {
		return ""
	}
	switch v := final.Output.(type) {
	case string:
		return strings.TrimSpace(v)
	default:
		b, _ := json.MarshalIndent(v, "", "  ")
		return strings.TrimSpace(string(b))
	}
}

func BuildHeartbeatTask(checklistPath string, memorySnapshot string) (string, bool, error) {
	checklist, empty, err := readHeartbeatChecklist(checklistPath)
	if err != nil {
		return "", true, err
	}

	var b strings.Builder
	b.WriteString("You are running a heartbeat checkpoint for the agent.\n")
	b.WriteString("Review the provided checklist and context. Always respond with a short summary of what you checked/did.\n")
	b.WriteString("If anything requires user attention or action, make that explicit in the summary.\n")
	b.WriteString("Do NOT output placeholders like HEARTBEAT_OK.\n")
	b.WriteString("Do NOT output mention it is a heartbeat.\n")
	b.WriteString("If the checklist is missing or empty, review recent short-term memory (if enabled) and current context to find things to do before summarizing.\n")
	b.WriteString("Prefer to resolve things yourself; avoid asking the user unless genuinely blocked.\n")
	b.WriteString("If the progress snapshot shows pending tasks or follow_ups (done < total), treat that as needing attention: pick ONE pending item and take the smallest next step now (tools optional, but use them if needed).\n")
	b.WriteString("You MUST take at least one concrete action step before returning a final response when pending items exist. Do not only acknowledge pending items.\n")
	if !empty {
		b.WriteString("\nChecklist:\n")
		b.WriteString(checklist)
		b.WriteString("\n")
	}
	if strings.TrimSpace(memorySnapshot) != "" {
		b.WriteString("\nRecent memory progress:\n")
		b.WriteString(strings.TrimSpace(memorySnapshot))
		b.WriteString("\n")
	}

	return b.String(), empty, nil
}

func BuildHeartbeatMeta(source string, interval time.Duration, checklistPath string, checklistEmpty bool, state *State, extra map[string]any) map[string]any {
	hb := map[string]any{
		"source":           source,
		"scheduled_at_utc": time.Now().UTC().Format(time.RFC3339),
		"interval":         interval.String(),
	}
	if strings.TrimSpace(checklistPath) != "" {
		hb["checklist_path"] = checklistPath
	}
	if checklistEmpty {
		hb["checklist_empty"] = true
	}
	if state != nil {
		failures, lastSuccess, lastError, _ := state.Snapshot()
		if failures > 0 {
			hb["failures"] = failures
		}
		if !lastSuccess.IsZero() {
			hb["last_success_utc"] = lastSuccess.UTC().Format(time.RFC3339)
		}
		if strings.TrimSpace(lastError) != "" {
			hb["last_error"] = lastError
		}
	}
	for k, v := range extra {
		if strings.TrimSpace(k) == "" {
			continue
		}
		hb[k] = v
	}
	return map[string]any{
		"trigger":   "heartbeat",
		"heartbeat": hb,
	}
}

func BuildHeartbeatProgressSnapshot(mgr *memory.Manager, maxItems int) (string, error) {
	if mgr == nil {
		return "", nil
	}
	summaries, err := mgr.LoadShortTermSummaries(mgr.ShortTermDays)
	if err != nil {
		return "", err
	}
	filtered := make([]memory.ShortTermSummary, 0, len(summaries))
	for _, s := range summaries {
		if s.TasksTotal == 0 && s.FollowUpsTotal == 0 {
			continue
		}
		filtered = append(filtered, s)
	}
	if len(filtered) == 0 {
		return "", nil
	}
	if maxItems <= 0 {
		maxItems = 50
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		return filtered[i].Date > filtered[j].Date
	})
	if len(filtered) > maxItems {
		filtered = filtered[:maxItems]
	}
	lines := make([]string, 0, len(filtered)+1)
	lines = append(lines, "[Memory:ShortTerm:Progress]")
	for _, s := range filtered {
		progress := fmt.Sprintf("[progress: tasks %d/%d, follow_ups %d/%d]", s.TasksDone, s.TasksTotal, s.FollowUpsDone, s.FollowUpsTotal)
		details := buildPendingDetails(mgr, s.RelPath)
		line := fmt.Sprintf("- %s: %s (%s) %s%s", s.Date, strings.TrimSpace(s.Summary), strings.TrimSpace(s.RelPath), progress, details)
		lines = append(lines, line)
	}
	return strings.TrimSpace(strings.Join(lines, "\n")), nil
}

type State struct {
	mu          sync.Mutex
	running     bool
	failures    int
	lastSuccess time.Time
	lastError   string
}

func (s *State) Start() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	s.running = true
	return true
}

func (s *State) EndSkipped() {
	s.mu.Lock()
	s.running = false
	s.mu.Unlock()
}

func (s *State) EndSuccess(now time.Time) {
	s.mu.Lock()
	s.running = false
	s.failures = 0
	s.lastError = ""
	s.lastSuccess = now
	s.mu.Unlock()
}

func (s *State) EndFailure(err error) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
	s.failures++
	if err != nil {
		s.lastError = strings.TrimSpace(err.Error())
	}
	if s.failures >= heartbeatFailureThreshold {
		msg := "heartbeat_failed"
		if s.lastError != "" {
			msg = fmt.Sprintf("heartbeat_failed (%s)", s.lastError)
		}
		s.failures = 0
		return true, "ALERT: " + msg
	}
	return false, ""
}

func (s *State) Snapshot() (failures int, lastSuccess time.Time, lastError string, running bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failures, s.lastSuccess, s.lastError, s.running
}

func readHeartbeatChecklist(path string) (string, bool, error) {
	path = pathutil.ExpandHomePath(path)
	if strings.TrimSpace(path) == "" {
		return "", true, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", true, nil
		}
		return "", true, err
	}
	content := string(raw)
	if isChecklistEmptyContent(content) {
		return "", true, nil
	}
	return strings.TrimSpace(content), false, nil
}

func isChecklistEmptyContent(content string) bool {
	stripped := heartbeatHTMLComment.ReplaceAllString(content, "")
	lines := strings.Split(stripped, "\n")
	for _, line := range lines {
		l := strings.TrimSpace(line)
		if l == "" {
			continue
		}
		if strings.HasPrefix(l, "#") {
			continue
		}
		return false
	}
	return true
}

func buildPendingDetails(mgr *memory.Manager, relPath string) string {
	if mgr == nil {
		return ""
	}
	relPath = strings.TrimSpace(relPath)
	if relPath == "" {
		return ""
	}
	abs := filepath.Join(mgr.Dir, filepath.FromSlash(relPath))
	data, err := os.ReadFile(abs)
	if err != nil {
		return ""
	}
	_, body, ok := memory.ParseFrontmatter(string(data))
	if !ok {
		body = string(data)
	}
	content := memory.ParseShortTermContent(body)
	pendingTasks := pendingItems(content.Tasks, 2)
	pendingFollow := pendingItems(content.FollowUps, 2)
	if len(pendingTasks) == 0 && len(pendingFollow) == 0 {
		return ""
	}
	var parts []string
	if len(pendingTasks) > 0 {
		parts = append(parts, "pending tasks: "+strings.Join(pendingTasks, "; "))
	}
	if len(pendingFollow) > 0 {
		parts = append(parts, "pending follow_ups: "+strings.Join(pendingFollow, "; "))
	}
	return " [" + strings.Join(parts, " | ") + "]"
}

func pendingItems(items []memory.TaskItem, limit int) []string {
	if limit <= 0 {
		limit = 2
	}
	out := make([]string, 0, limit)
	for _, it := range items {
		if it.Done {
			continue
		}
		text := strings.TrimSpace(it.Text)
		if text == "" {
			continue
		}
		out = append(out, text)
		if len(out) >= limit {
			break
		}
	}
	return out
}

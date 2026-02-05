package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

const (
	heartbeatOK               = "HEARTBEAT_OK"
	heartbeatAlertPrefix      = "ALERT:"
	heartbeatFailureThreshold = 3
)

var heartbeatHTMLComment = regexp.MustCompile(`(?s)<!--.*?-->`)

func formatFinalOutput(final *agent.Final) string {
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

func isHeartbeatOK(output string) bool {
	return strings.EqualFold(strings.TrimSpace(output), heartbeatOK)
}

func isHeartbeatAlert(output string) bool {
	out := strings.TrimSpace(output)
	return strings.HasPrefix(strings.ToUpper(out), heartbeatAlertPrefix)
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

func buildHeartbeatTask(checklistPath string) (string, bool, error) {
	checklist, empty, err := readHeartbeatChecklist(checklistPath)
	if err != nil {
		return "", true, err
	}

	var b strings.Builder
	b.WriteString("You are running a heartbeat checkpoint for the agent.\n")
	b.WriteString("Review the provided checklist and context. If no user-visible action is needed, respond with EXACTLY: HEARTBEAT_OK\n")
	b.WriteString("If anything requires user attention or action, respond with: ALERT: <short summary>\n")
	b.WriteString("If the checklist is missing or empty, review recent short-term memory (if enabled) and current context to find things to do before returning HEARTBEAT_OK.\n")
	b.WriteString("Prefer to resolve things yourself; avoid asking the user unless genuinely blocked.\n")
	if !empty {
		b.WriteString("\nChecklist:\n")
		b.WriteString(checklist)
		b.WriteString("\n")
	}

	return b.String(), empty, nil
}

func buildHeartbeatMeta(source string, interval time.Duration, checklistPath string, checklistEmpty bool, state *heartbeatState, extra map[string]any) map[string]any {
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

type heartbeatState struct {
	mu          sync.Mutex
	running     bool
	failures    int
	lastSuccess time.Time
	lastError   string
}

func (s *heartbeatState) Start() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	s.running = true
	return true
}

func (s *heartbeatState) EndSkipped() {
	s.mu.Lock()
	s.running = false
	s.mu.Unlock()
}

func (s *heartbeatState) EndSuccess(now time.Time) {
	s.mu.Lock()
	s.running = false
	s.failures = 0
	s.lastError = ""
	s.lastSuccess = now
	s.mu.Unlock()
}

func (s *heartbeatState) EndFailure(err error) (bool, string) {
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

func (s *heartbeatState) Snapshot() (failures int, lastSuccess time.Time, lastError string, running bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failures, s.lastSuccess, s.lastError, s.running
}

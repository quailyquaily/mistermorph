package agent

import (
	"regexp"
	"strings"
)

var numberedListRe = regexp.MustCompile(`(?m)^\s*\d+\.\s+`)

// TaskNeedsPlan is a lightweight heuristic for determining whether a task is
// likely to benefit from an explicit plan step before execution.
func TaskNeedsPlan(task string) bool {
	t := strings.TrimSpace(task)
	if t == "" {
		return false
	}

	words := len(strings.Fields(t))
	lines := 1 + strings.Count(t, "\n")

	// Strong signals: multi-line / long tasks.
	if words >= 45 || lines >= 6 {
		return true
	}

	// Explicit multi-step phrasing.
	if len(numberedListRe.FindAllStringIndex(t, -1)) >= 2 {
		return true
	}

	lower := strings.ToLower(t)
	keywords := []string{
		"implement", "refactor", "design", "architecture", "end-to-end",
		"integrate", "migration", "migrate", "optimize", "add support",
		"across", "multiple", "rollout", "plan mode", "roadmap",
	}
	hits := 0
	for _, kw := range keywords {
		if strings.Contains(lower, kw) {
			hits++
		}
	}
	if hits >= 2 {
		return true
	}

	// Moderate signal: compound instruction.
	if words >= 25 && strings.Count(lower, " and ") >= 2 {
		return true
	}

	return false
}

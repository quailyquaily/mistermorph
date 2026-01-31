package agent

import (
	"regexp"
	"strings"
)

// Matches common "write/save/output to <path>" phrasing.
// Captures the path, optionally wrapped in backticks or quotes.
var fileWriteRe = regexp.MustCompile(`(?i)(?:write(?:\s+down)?|save|output)\s+(?:it\s+)?(?:to|into)\s+[` + "`" + `"'"]?([^` + "`" + `"'\\s]+)[` + "`" + `"'"]?`)

func ExtractFileWritePaths(task string) []string {
	t := strings.TrimSpace(task)
	if t == "" {
		return nil
	}

	matches := fileWriteRe.FindAllStringSubmatch(t, -1)
	if len(matches) == 0 {
		return nil
	}

	seen := make(map[string]bool)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		p := strings.TrimSpace(m[1])
		p = strings.Trim(p, "`\"'")
		if p == "" {
			continue
		}
		key := strings.ToLower(p)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, p)
	}
	return out
}

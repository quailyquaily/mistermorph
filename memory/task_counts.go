package memory

import (
	"fmt"
	"strconv"
	"strings"
)

func taskCounts(items []TaskItem) (done int, total int) {
	for _, it := range items {
		text := strings.TrimSpace(it.Text)
		if text == "" {
			continue
		}
		total++
		if it.Done {
			done++
		}
	}
	return done, total
}

func formatTaskRatio(done int, total int) string {
	if done < 0 {
		done = 0
	}
	if total < 0 {
		total = 0
	}
	return fmt.Sprintf("%d/%d", done, total)
}

func parseTaskRatio(val string) (done int, total int, ok bool) {
	val = strings.TrimSpace(val)
	if val == "" {
		return 0, 0, false
	}
	parts := strings.Split(val, "/")
	if len(parts) != 2 {
		return 0, 0, false
	}
	d, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || d < 0 {
		return 0, 0, false
	}
	t, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || t < 0 {
		return 0, 0, false
	}
	return d, t, true
}

package runtimeclock

import (
	"strings"
	"time"
)

func WithRuntimeClockMeta(meta map[string]any, now time.Time) map[string]any {
	out := make(map[string]any, len(meta)+4)
	for k, v := range meta {
		out[k] = v
	}

	loc := now.Location()
	tzName := "Local"
	if loc != nil && strings.TrimSpace(loc.String()) != "" {
		tzName = strings.TrimSpace(loc.String())
	}

	out["now_utc"] = now.UTC().Format(time.RFC3339)
	out["now_local"] = now.Format(time.RFC3339)
	out["timezone"] = tzName
	out["utc_offset"] = now.Format("-07:00")
	return out
}

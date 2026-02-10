package agent

import (
	"encoding/json"
	"strings"
)

const maxInjectedMetaBytes = 4 * 1024

func buildInjectedMetaMessage(meta map[string]any) (string, bool) {
	if len(meta) == 0 {
		return "", false
	}

	envelope := map[string]any{"mister_morph_meta": meta}
	b, err := json.Marshal(envelope)
	if err == nil && len(b) <= maxInjectedMetaBytes {
		return string(b), true
	}

	// Truncate best-effort by keeping only essential keys.
	stub := map[string]any{
		"truncated": true,
	}
	if v, ok := meta["trigger"]; ok {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			stub["trigger"] = s
		}
	}
	if v, ok := meta["correlation_id"]; ok {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			stub["correlation_id"] = s
		}
	}
	b, err = json.Marshal(map[string]any{"mister_morph_meta": stub})
	if err == nil && len(b) <= maxInjectedMetaBytes {
		return string(b), true
	}

	// Final fallback: smallest possible stub.
	b, err = json.Marshal(map[string]any{"mister_morph_meta": map[string]any{"truncated": true}})
	if err != nil {
		return `{"mister_morph_meta":{"truncated":true}}`, true
	}
	return string(b), true
}

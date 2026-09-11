package outputfmt

import (
	"encoding/json"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
)

// FormatFinalOutput renders final output for delivery channels.
// It preserves structured outputs as pretty JSON and normalizes string outputs.
func FormatFinalOutput(final *agent.Final) string {
	if final == nil {
		return ""
	}
	switch v := final.Output.(type) {
	case string:
		return normalizeFinalStringOutput(v)
	default:
		b, _ := json.MarshalIndent(v, "", "  ")
		if string(b) == "null" {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
}

func normalizeFinalStringOutput(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}

	if decoded, ok := decodeJSONStringLiteral(s); ok {
		s = strings.TrimSpace(decoded)
	}

	if shouldDecodeEscapedMultiline(s) {
		s = strings.TrimSpace(decodeEscapedMultiline(s))
	}
	return s
}

func decodeJSONStringLiteral(s string) (string, bool) {
	if len(s) < 2 || !strings.HasPrefix(s, "\"") || !strings.HasSuffix(s, "\"") {
		return "", false
	}
	var out string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return "", false
	}
	return out, true
}

func shouldDecodeEscapedMultiline(s string) bool {
	if !strings.Contains(s, `\`) {
		return false
	}
	escapedNewlines := strings.Count(s, `\n`) + strings.Count(s, `\r`)
	if escapedNewlines >= 2 && !strings.ContainsAny(s, "\n\r") {
		return true
	}
	if escapedNewlines >= 3 {
		return true
	}
	return false
}

func decodeEscapedMultiline(s string) string {
	replacer := strings.NewReplacer(
		`\r\n`, "\n",
		`\n`, "\n",
		`\r`, "\n",
	)
	return replacer.Replace(s)
}

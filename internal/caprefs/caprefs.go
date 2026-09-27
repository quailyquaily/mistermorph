package caprefs

import (
	"regexp"
	"strings"
)

var dollarNameRe = regexp.MustCompile(`(^|[^A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_.-]*)`)

func Names(text string) []string {
	matches := dollarNameRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(matches))
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		// A name may hold dots and dashes (my.skill-name), but a trailing one is the sentence's
		// punctuation: "call $bash." names bash.
		name := strings.TrimRight(text[m[4]:m[5]], ".-")
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, name)
	}
	return out
}

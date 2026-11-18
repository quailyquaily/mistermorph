package proctrack

import "strings"

// tagsFrom picks the MISTERMORPH_* tags out of NUL-separated KEY=VALUE strings.
func tagsFrom(entries []string) map[string]string {
	var tags map[string]string
	for _, kv := range entries {
		if !strings.HasPrefix(kv, "MISTERMORPH_") {
			continue
		}
		key, value, ok := strings.Cut(kv, "=")
		if !ok || (key != EnvRun && key != EnvCall && key != EnvCoder) {
			continue
		}
		if tags == nil {
			tags = map[string]string{}
		}
		tags[key] = value
	}
	return tags
}

func splitNUL(b []byte) []string {
	var out []string
	for _, part := range strings.Split(string(b), "\x00") {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

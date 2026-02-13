package markdown

import (
	"strings"

	"gopkg.in/yaml.v3"
)

// ParseFrontmatter parses YAML frontmatter into a typed object and returns the markdown body.
// ok=false means either no frontmatter exists, or frontmatter is invalid.
func ParseFrontmatter[T any](contents string) (T, string, bool) {
	var zero T
	raw, body, hasFrontmatter := SplitFrontmatter(contents)
	if !hasFrontmatter {
		return zero, contents, false
	}

	var out T
	if err := yaml.Unmarshal([]byte(raw), &out); err != nil {
		return zero, body, false
	}
	return out, body, true
}

// FrontmatterStatus returns the "status" field from YAML frontmatter.
func FrontmatterStatus(contents string) string {
	type frontmatterStatus struct {
		Status string `yaml:"status"`
	}
	fm, _, ok := ParseFrontmatter[frontmatterStatus](contents)
	if !ok {
		raw, _, hasFrontmatter := SplitFrontmatter(contents)
		if !hasFrontmatter {
			return ""
		}
		for _, line := range strings.Split(raw, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(strings.ToLower(trimmed), "status:") {
				return strings.TrimSpace(trimmed[len("status:"):])
			}
		}
		return ""
	}
	return strings.TrimSpace(fm.Status)
}

// StripFrontmatter removes a leading YAML frontmatter block if it exists.
func StripFrontmatter(contents string) string {
	_, body, ok := SplitFrontmatter(contents)
	if !ok {
		return contents
	}
	return body
}

// SplitFrontmatter splits a markdown document into raw YAML frontmatter and body.
// The delimiters must be a leading line "---" and a later closing line "---".
func SplitFrontmatter(contents string) (string, string, bool) {
	lines := strings.Split(strings.ReplaceAll(contents, "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", contents, false
	}

	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) != "---" {
			continue
		}
		return strings.Join(lines[1:i], "\n"), strings.Join(lines[i+1:], "\n"), true
	}
	return "", contents, false
}

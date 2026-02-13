package memory

import (
	"strings"

	markdownutil "github.com/quailyquaily/mistermorph/internal/markdown"
	"gopkg.in/yaml.v3"
)

func ParseFrontmatter(contents string) (Frontmatter, string, bool) {
	return markdownutil.ParseFrontmatter[Frontmatter](contents)
}

func RenderFrontmatter(fm Frontmatter) string {
	data, _ := yaml.Marshal(fm)
	body := strings.TrimSpace(string(data))
	if body != "" {
		body += "\n"
	}
	return "---\n" + body + "---\n"
}

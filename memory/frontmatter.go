package memory

import (
	"bufio"
	"strings"

	"gopkg.in/yaml.v3"
)

func ParseFrontmatter(contents string) (Frontmatter, string, bool) {
	sc := bufio.NewScanner(strings.NewReader(contents))
	if !sc.Scan() {
		return Frontmatter{}, contents, false
	}
	if strings.TrimSpace(sc.Text()) != "---" {
		return Frontmatter{}, contents, false
	}

	var yamlLines []string
	foundEnd := false
	var bodyLines []string
	for sc.Scan() {
		line := sc.Text()
		if !foundEnd {
			if strings.TrimSpace(line) == "---" {
				foundEnd = true
				continue
			}
			yamlLines = append(yamlLines, line)
			continue
		}
		bodyLines = append(bodyLines, line)
	}
	if !foundEnd {
		return Frontmatter{}, contents, false
	}

	var fm Frontmatter
	if err := yaml.Unmarshal([]byte(strings.Join(yamlLines, "\n")), &fm); err != nil {
		return Frontmatter{}, strings.Join(bodyLines, "\n"), false
	}
	return fm, strings.Join(bodyLines, "\n"), true
}

func RenderFrontmatter(fm Frontmatter) string {
	data, _ := yaml.Marshal(fm)
	body := strings.TrimSpace(string(data))
	if body != "" {
		body += "\n"
	}
	return "---\n" + body + "---\n"
}

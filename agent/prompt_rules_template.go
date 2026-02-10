package agent

import (
	_ "embed"
	"strings"
)

//go:embed prompts/system_rules.tmpl
var systemRulesTemplateSource string

//go:embed prompts/todo_rules.tmpl
var todoRulesTemplateSource string

func defaultSystemRules() []string {
	sources := []string{
		systemRulesTemplateSource,
		todoRulesTemplateSource,
	}
	out := make([]string, 0, 64)
	seen := make(map[string]struct{}, 64)
	for _, src := range sources {
		lines := strings.Split(src, "\n")
		for _, raw := range lines {
			rule := strings.TrimSpace(raw)
			if rule == "" || strings.HasPrefix(rule, "#") {
				continue
			}
			if _, ok := seen[rule]; ok {
				continue
			}
			seen[rule] = struct{}{}
			out = append(out, rule)
		}
	}
	return out
}

package agent

import (
	_ "embed"
	"strings"
)

//go:embed prompts/system_rules.tmpl
var systemRulesTemplateSource string

func defaultSystemRules() []string {
	lines := strings.Split(systemRulesTemplateSource, "\n")
	out := make([]string, 0, len(lines))
	for _, raw := range lines {
		rule := strings.TrimSpace(raw)
		if rule == "" || strings.HasPrefix(rule, "#") {
			continue
		}
		out = append(out, rule)
	}
	return out
}

package claudeterm

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var numberedOption = regexp.MustCompile(`^([1-9][0-9]*)\. (?:\(selected\) )?(.*)$`)

type screenView struct {
	idle     bool
	question *Question
	keys     []string
	problem  string
	rule     string // Prefilled permission rule waiting for Enter.
}

// parseScreen recognizes screen-reader prompts, not the code and tool output above them.
func parseScreen(screen string) screenView {
	lines := strings.Split(strings.TrimSpace(screen), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	textLine := last
	if last == "Esc to cancel" && len(lines) > 1 {
		textLine = strings.TrimSpace(lines[len(lines)-2])
	}
	if strings.HasPrefix(textLine, "Enter text for option ") {
		// The input echo or prefilled value follows the colon; it is not a new question.
		prompt, value, _ := strings.Cut(textLine, ":")
		permission, question := -1, -1
		for i, line := range lines {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Permission Required:") {
				permission = i
			}
			if strings.HasPrefix(line, "Question:") {
				question = i
			}
		}
		if permission > question {
			// "Don't ask again" opens the rule to save, prefilled with Claude's suggestion.
			if value = strings.TrimSpace(value); value == "" {
				return screenView{problem: "Claude asked for a permission rule without a suggestion"}
			}
			return screenView{rule: value}
		}
		var description []string
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Question:") {
				description = nil
			}
			if strings.HasPrefix(line, "Question:") || strings.HasPrefix(line, "> ") {
				description = append(description, strings.TrimPrefix(line, "> "))
			}
		}
		description = append(description, prompt+":")
		return screenView{question: &Question{Text: strings.Join(description, "\n")}}
	}
	if last == "$" {
		for _, line := range lines[max(0, len(lines)-4):] {
			if strings.Contains(line, "esc to interrupt") {
				return screenView{}
			}
		}
		return screenView{idle: true}
	}
	start, footer := -1, -1
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Permission Required:") || strings.HasPrefix(line, "Question:") {
			start = i
		}
		if strings.HasPrefix(line, "Select with numbers [") || strings.HasPrefix(line, "Enter y/n:") {
			footer = i
		}
	}
	if footer < 0 || footer < len(lines)-2 || start > footer {
		return screenView{}
	}
	if start < 0 {
		return screenView{problem: "Claude's prompt does not fit the supported screen-reader layout"}
	}
	q := &Question{ChoicesOnly: true}
	v := screenView{question: q}
	var description []string
	for _, raw := range lines[start:footer] {
		line := strings.TrimSpace(raw)
		if match := numberedOption.FindStringSubmatch(line); match != nil {
			v.keys = append(v.keys, match[1])
			q.Options = append(q.Options, match[2])
		} else if strings.HasPrefix(line, "y. ") || strings.HasPrefix(line, "n. ") {
			v.keys = append(v.keys, line[:1])
			q.Options = append(q.Options, line[3:])
		} else if len(q.Options) > 0 {
			// Long option labels wrap at the fixed terminal width.
			q.Options[len(q.Options)-1] += " " + line
		} else {
			description = append(description, strings.TrimPrefix(line, "> "))
		}
	}
	if len(q.Options) == 0 {
		return screenView{problem: "Claude presented an unsupported question"}
	}
	q.Text = strings.Join(description, "\n")
	// File approvals need the target and decision, not a replay of the edit preview.
	if strings.HasPrefix(q.Text, "Permission Required:") && strings.Contains(description[0], "file") {
		var relevant []string
		for i, line := range description {
			if i < 2 || strings.HasPrefix(line, "Do you want") {
				relevant = append(relevant, line)
			}
		}
		q.Text = strings.Join(relevant, "\n")
	}
	return v
}

func (v screenView) answer(a Answer) (string, error) {
	if a.Option < 0 {
		if v.question.ChoicesOnly {
			return "", fmt.Errorf("this Claude prompt requires an option")
		}
		if err := checkText(a.Text); err != nil {
			return "", err
		}
		return strings.NewReplacer("\n", " ", "\r", " ", "\t", " ").Replace(a.Text), nil
	}
	if a.Option >= len(v.keys) {
		return "", fmt.Errorf("Claude option %s is not available", strconv.Itoa(a.Option+1))
	}
	return v.keys[a.Option], nil
}

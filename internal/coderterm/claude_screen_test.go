package coderterm

import (
	"strings"
	"testing"
)

func TestScreenReaderPrompts(t *testing.T) {
	for _, tt := range []struct {
		name, screen string
		options      int
		idle         bool
	}{
		{"starting", "", 0, false},
		{"busy", "tool: Write (source.go)\nWorking…\nmanual mode on · esc to interrupt\n$", 0, false},
		{"idle", "claude: Done\nmanual mode on\n$", 0, true},
		{"transcript is not a prompt", "claude: Question: misleading text\n1. Yes\n2. No\nmanual mode on\n$", 0, true},
		{"choice", "Question: Format\n> Which format should we use?\n1. Markdown — Readable text\n2. JSON — Structured data\n3. Other\n4. Chat about this\nSelect with numbers [1-4]. Then Enter to submit or Escape to cancel:", 4, false},
		{"trust", "Permission Required: Accessing workspace:\nworkspace\ny. Yes, I trust this folder\nn. No, exit\nEnter y/n:\nEnter to confirm · Esc to cancel", 2, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			v := parseClaudeScreen(tt.screen)
			if v.rule != "" {
				t.Fatalf("unexpected rule %q", v.rule)
			}
			if v.problem != "" {
				t.Fatal(v.problem)
			}
			if v.idle != tt.idle {
				t.Fatalf("idle=%v", v.idle)
			}
			if tt.options > 0 {
				if v.question == nil || len(v.question.Options) != tt.options {
					t.Fatalf("question=%+v", v.question)
				}
			} else if v.question != nil {
				t.Fatal("unexpected question")
			}
		})
	}
}

func TestFilePermissionPreservesDecisionWithoutDiff(t *testing.T) {
	v := parseClaudeScreen("Permission Required: Create file\nexample.txt\n 1 private edit contents\nDo you want to create example.txt?\n1. Yes\n2. Yes, and switch to accept edits (auto-approve file edits and common file\ncommands) for this session (shift+tab)\n3. No\nSelect with numbers [1-3]. Then Enter to submit or Escape to cancel:\nEsc to cancel")
	if v.question == nil {
		t.Fatalf("view=%+v", v)
	}
	if strings.Contains(v.question.Text, "private edit") || !strings.Contains(v.question.Text, "example.txt") {
		t.Fatal(v.question.Text)
	}
	if !strings.Contains(v.question.Options[1], "commands) for this session") {
		t.Fatal(v.question.Options)
	}
	if _, err := v.answer(Answer{Option: -1, Text: "yes"}); err == nil {
		t.Fatal("permission accepted text")
	}
	input, err := v.answer(Answer{Option: 2})
	if err != nil || input != "3" {
		t.Fatalf("input=%q err=%v", input, err)
	}
}

func TestTextEchoDoesNotOpenAnotherQuestion(t *testing.T) {
	prompt := "Question: Format\n> Which format should we use?\nEnter text for option 3 (Other), or Escape for the list:"
	before := parseClaudeScreen(prompt)
	after := parseClaudeScreen(prompt + " plain 文本")
	if before.question.Text != after.question.Text {
		t.Fatalf("input echo changed question: %q", after.question.Text)
	}
}

func TestTextFieldsBeforeEscapeHint(t *testing.T) {
	// Captured from Claude Code 2.1.316 after choosing "don't ask again" on a Bash prompt.
	rule := "Permission Required: Bash command\n> go run hello.go | od -c && ls -la\nDo you want to proceed?\n1. Yes\n2. Yes, and don’t ask again for\n3. No\n" +
		"Enter text for option 2 (Yes, and don’t ask again for), or Escape for the list: go run *\nEsc to cancel"
	if v := parseClaudeScreen(rule); v.rule != "go run *" || v.question != nil || v.problem != "" {
		t.Fatalf("rule field: %+v", v)
	}
	if v := parseClaudeScreen(strings.TrimSuffix(rule, "go run *\nEsc to cancel") + "\nEsc to cancel"); v.problem == "" {
		t.Fatal("empty rule accepted")
	}
	other := "Question: Format\n> Which format?\n1. Markdown\n2. Other\nEnter text for option 2: draft\nEsc to cancel"
	if v := parseClaudeScreen(other); v.question == nil || v.rule != "" || v.question.ChoicesOnly || !strings.HasSuffix(v.question.Text, "Enter text for option 2:") {
		t.Fatalf("Other field: %+v", v)
	}
}

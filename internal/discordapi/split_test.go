package discordapi

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSplitContent(t *testing.T) {
	if got := SplitContent("  hi  ", 0); len(got) != 1 || got[0] != "hi" {
		t.Fatalf("short = %q", got)
	}
	if got := SplitContent("   ", 0); got != nil {
		t.Fatalf("empty = %q", got)
	}

	paragraphs := strings.Repeat("a", 30) + "\n\n" + strings.Repeat("b", 30) + "\n\n" + strings.Repeat("c", 30)
	got := SplitContent(paragraphs, 70)
	if len(got) != 2 || got[0] != strings.Repeat("a", 30)+"\n\n"+strings.Repeat("b", 30) || got[1] != strings.Repeat("c", 30) {
		t.Fatalf("paragraphs = %q", got)
	}

	// A long answer in Chinese is split by characters, not bytes.
	long := strings.Repeat("字", 4500)
	for _, part := range SplitContent(long, 0) {
		if utf8.RuneCountInString(part) > MaxMessageLength {
			t.Fatalf("part has %d characters", utf8.RuneCountInString(part))
		}
	}
}

func TestSplitContentKeepsCodeBlocksClosed(t *testing.T) {
	var lines []string
	for i := 0; i < 40; i++ {
		lines = append(lines, "fmt.Println(\"line\")")
	}
	text := "Here:\n```go\n" + strings.Join(lines, "\n") + "\n```\nDone."
	parts := SplitContent(text, 300)
	if len(parts) < 3 {
		t.Fatalf("parts = %d", len(parts))
	}
	for i, part := range parts {
		if utf8.RuneCountInString(part) > 300 {
			t.Fatalf("part %d has %d characters", i, utf8.RuneCountInString(part))
		}
		if strings.Count(part, "```")%2 != 0 {
			t.Fatalf("part %d leaves a code block open:\n%s", i, part)
		}
		if i > 0 && i < len(parts)-1 && !strings.HasPrefix(part, "```go\n") {
			t.Fatalf("part %d does not reopen the go block:\n%s", i, part)
		}
	}
	joined := strings.Join(parts, "\n")
	if !strings.HasPrefix(joined, "Here:") || !strings.HasSuffix(joined, "Done.") {
		t.Fatalf("content lost: %q ... %q", joined[:20], joined[len(joined)-20:])
	}
}

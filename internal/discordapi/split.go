package discordapi

import (
	"strings"
	"unicode/utf8"
)

// SplitContent splits Markdown into messages of at most max characters (MaxMessageLength when max
// is 0). It breaks at paragraph ends, then line ends, then anywhere, and never leaves a code block
// open: a part that ends inside a fence closes it, and the next part reopens it with the same
// language.
func SplitContent(text string, max int) []string {
	if max <= 0 {
		max = MaxMessageLength
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if utf8.RuneCountInString(text) <= max {
		return []string{text}
	}
	var parts []string
	fence := "" // the opening line of the code block the previous part left open
	rest := text
	for rest != "" {
		prefix := ""
		if fence != "" {
			prefix = fence + "\n"
		}
		// Room for the reopened fence and, if needed, a closing one.
		budget := max - utf8.RuneCountInString(prefix) - len("\n```")
		if budget < 1 {
			budget = 1
		}
		if utf8.RuneCountInString(rest) <= max-utf8.RuneCountInString(prefix) {
			parts = append(parts, prefix+rest)
			break
		}
		cut := breakPoint(rest, budget)
		chunk := strings.TrimRight(rest[:cut], " \t\n")
		rest = strings.TrimLeft(rest[cut:], "\n")
		part := prefix + chunk
		fence = openFence(fence, chunk)
		if fence != "" {
			part += "\n```"
		}
		parts = append(parts, part)
	}
	return parts
}

// breakPoint is a byte offset of at most budget characters into text: after the last blank line,
// else the last line end, else the last space, else budget characters in.
func breakPoint(text string, budget int) int {
	limit := len(text)
	count := 0
	for offset := range text {
		if count == budget {
			limit = offset
			break
		}
		count++
	}
	window := text[:limit]
	for _, sep := range []string{"\n\n", "\n", " "} {
		if i := strings.LastIndex(window, sep); i > 0 {
			return i + len(sep)
		}
	}
	return limit
}

// openFence follows the code fences in chunk, starting inside the block whose opening line is
// fence ("" when outside), and returns the opening line of the block still open at its end.
func openFence(fence, chunk string) string {
	for _, line := range strings.Split(chunk, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "```") {
			continue
		}
		if fence == "" {
			fence = trimmed
		} else {
			fence = ""
		}
	}
	return fence
}

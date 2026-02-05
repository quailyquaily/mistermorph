package telegramutil

import "strings"

func EscapeTelegramMarkdownUnderscores(text string) string {
	if !strings.Contains(text, "_") {
		return text
	}

	var b strings.Builder
	b.Grow(len(text) + 8)

	inCodeBlock := false
	inInlineCode := false

	for i := 0; i < len(text); i++ {
		// Toggle fenced code blocks with ```
		if !inInlineCode && strings.HasPrefix(text[i:], "```") {
			inCodeBlock = !inCodeBlock
			b.WriteString("```")
			i += 2
			continue
		}

		ch := text[i]

		// Toggle inline code with `
		if !inCodeBlock && ch == '`' {
			inInlineCode = !inInlineCode
			b.WriteByte(ch)
			continue
		}

		// Escape underscores outside code.
		if !inCodeBlock && !inInlineCode && ch == '_' {
			// Avoid double-escaping if the user/model already emitted \_
			if i > 0 && text[i-1] == '\\' {
				b.WriteByte('_')
				continue
			}
			b.WriteByte('\\')
			b.WriteByte('_')
			continue
		}

		b.WriteByte(ch)
	}

	return b.String()
}

package telegramutil

import "strings"

var markdownV2Escapes = map[byte]bool{
	'\\': true,
	'_':  true,
	'*':  true,
	'[':  true,
	']':  true,
	'(':  true,
	')':  true,
	'~':  true,
	'`':  true,
	'>':  true,
	'#':  true,
	'+':  true,
	'-':  true,
	'=':  true,
	'|':  true,
	'{':  true,
	'}':  true,
	'.':  true,
	'!':  true,
}

func EscapeMarkdownV2(text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	var b strings.Builder
	b.Grow(len(text) + 8)
	for i := 0; i < len(text); i++ {
		ch := text[i]
		if markdownV2Escapes[ch] {
			b.WriteByte('\\')
		}
		b.WriteByte(ch)
	}
	return b.String()
}

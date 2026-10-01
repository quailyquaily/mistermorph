package discordapi

import "github.com/quailyquaily/mistermorph/internal/textsplit"

// SplitContent splits Markdown into messages of at most max characters (MaxMessageLength when max
// is 0), never leaving a code block open across parts.
func SplitContent(text string, max int) []string {
	if max <= 0 {
		max = MaxMessageLength
	}
	return textsplit.Split(text, max)
}

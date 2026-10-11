package xapi

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// urlWeight is what X counts for any link: it shortens every URL to 23 characters.
const urlWeight = 23

var urlPattern = regexp.MustCompile(`https?://[^\s]+`)

// Weight is a text's length as X counts it: most Latin characters count 1, others (CJK, emoji)
// count 2, and each URL counts 23.
func Weight(text string) int {
	total, last := 0, 0
	for _, loc := range urlPattern.FindAllStringIndex(text, -1) {
		total += runesWeight(text[last:loc[0]]) + urlWeight
		last = loc[1]
	}
	return total + runesWeight(text[last:])
}

func runesWeight(text string) int {
	total := 0
	for _, r := range text {
		total += runeWeight(r)
	}
	return total
}

// runeWeight follows X's weighting ranges: these count 1, everything else 2.
func runeWeight(r rune) int {
	switch {
	case r <= 0x10FF, r >= 0x2000 && r <= 0x200D, r >= 0x2010 && r <= 0x201F, r >= 0x2032 && r <= 0x2037:
		return 1
	}
	return 2
}

// SplitPosts cuts text into posts that each fit MaxPostWeight, breaking at paragraph ends, then
// line ends, then spaces, then anywhere; at most maxPosts, the last cut with an ellipsis.
func SplitPosts(text string, maxPosts int) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if maxPosts <= 0 {
		maxPosts = 1
	}
	var parts []string
	for text != "" && len(parts) < maxPosts {
		if Weight(text) <= MaxPostWeight {
			parts = append(parts, text)
			text = ""
			break
		}
		budget := MaxPostWeight
		if len(parts) == maxPosts-1 {
			// The last post keeps room for the ellipsis.
			budget--
		}
		cut := cutPoint(text, budget)
		parts = append(parts, strings.TrimSpace(text[:cut]))
		text = strings.TrimSpace(text[cut:])
	}
	if text != "" && len(parts) > 0 {
		parts[len(parts)-1] += "…"
	}
	return parts
}

// cutPoint is the byte index to cut text at so that text[:cut] fits budget.
func cutPoint(text string, budget int) int {
	fit := 0
	weight := 0
	for i, r := range text {
		w := runeWeight(r)
		if weight+w > budget {
			break
		}
		weight += w
		fit = i + utf8.RuneLen(r)
	}
	if fit == 0 {
		_, size := utf8.DecodeRuneInString(text)
		return size
	}
	head := text[:fit]
	for _, sep := range []string{"\n\n", "\n", " "} {
		if i := strings.LastIndex(head, sep); i > fit/2 {
			return i + len(sep)
		}
	}
	return fit
}

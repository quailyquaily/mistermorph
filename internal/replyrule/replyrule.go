// Package replyrule holds the one rule for when a message gets only an emoji, shared by the main
// loop's system prompt, the group check and the lightweight pre-check, so they judge alike.
package replyrule

import (
	_ "embed"
	"strings"
)

//go:embed rule.md
var source string

// Text is the rule as Markdown bullets.
var Text = strings.TrimSpace(source)

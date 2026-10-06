package caprefs

import (
	"regexp"
	"strings"
)

var dollarNameRe = regexp.MustCompile(`(^|[^A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_.-]*)`)

// Ref is one $name reference: Raw as written, and Name without trailing dots and dashes, which
// usually belong to the sentence ("call $bash." names bash).
type Ref struct {
	Raw  string
	Name string
}

// Refs returns the $name references in text, once per name ignoring case, in order.
func Refs(text string) []Ref {
	matches := dollarNameRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(matches))
	out := make([]Ref, 0, len(matches))
	for _, m := range matches {
		raw := text[m[4]:m[5]]
		name := strings.TrimRight(raw, ".-")
		if name == "" {
			continue
		}
		key := strings.ToLower(raw)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, Ref{Raw: raw, Name: name})
	}
	return out
}

// Names returns the referenced names with trailing punctuation trimmed, once each ignoring case.
func Names(text string) []string {
	refs := Refs(text)
	if len(refs) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(refs))
	out := make([]string, 0, len(refs))
	for _, ref := range refs {
		key := strings.ToLower(ref.Name)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ref.Name)
	}
	return out
}

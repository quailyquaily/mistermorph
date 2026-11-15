package agent

import (
	"regexp"
	"strings"
)

// fileWriteLeadRe matches the lead-in of "write/save/output [it] to|into <destination>".
// The destination itself is read by readWriteDestination, so that a quoted destination can
// hold spaces and an unquoted one ends at whitespace.
var fileWriteLeadRe = regexp.MustCompile(`(?i)(?:write(?:\s+down)?|save|output)\s+(?:it\s+)?(?:to|into)\s+`)

const fileWriteQuotes = "`\"'"

// ExtractFileWritePaths returns the explicit file destinations a task asks to write to, in
// the order they appear and without duplicates.
//
// A destination counts only when it is certainly a file: its last path element has an
// extension ("design/mobile-popups.md") or is a dotfile (".env"). A directory ("design/"),
// plain prose ("write down to the design/ folder", "save it to disk") and a URL name no
// file, so they return nothing and the run may choose its own file name. An unquoted
// destination ends at whitespace; a destination in backticks or quotes may contain spaces.
// The case of a path is kept as written.
func ExtractFileWritePaths(task string) []string {
	t := strings.TrimSpace(task)
	if t == "" {
		return nil
	}

	var out []string
	seen := make(map[string]bool)
	for _, loc := range fileWriteLeadRe.FindAllStringIndex(t, -1) {
		p, ok := readWriteDestination(t[loc[1]:])
		if !ok || !isExplicitFilePath(p) || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}

// readWriteDestination reads the destination at the start of rest. A destination that opens
// with a quote runs to the same quote on the same line; one without a closing quote is
// malformed and is not a destination.
func readWriteDestination(rest string) (string, bool) {
	if rest == "" {
		return "", false
	}
	if quote := rest[0]; strings.IndexByte(fileWriteQuotes, quote) >= 0 {
		end := strings.IndexAny(rest[1:], string(quote)+"\r\n")
		if end < 0 || rest[1+end] != quote {
			return "", false
		}
		p := strings.TrimSpace(rest[1 : 1+end])
		return p, p != ""
	}
	end := strings.IndexFunc(rest, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\r' || r == '\n' || r == ' ' || r == '　' ||
			strings.ContainsRune(fileWriteQuotes, r)
	})
	if end >= 0 {
		rest = rest[:end]
	}
	// Sentence punctuation around the path is not part of it.
	p := strings.TrimLeft(rest, "([{<")
	p = strings.TrimRight(p, ".,;:!?)]}>")
	return p, p != ""
}

// isExplicitFilePath reports whether p certainly names a file rather than a directory or a
// word of the sentence.
func isExplicitFilePath(p string) bool {
	if p == "" || strings.ContainsAny(p, "\x00\r\n") || strings.Contains(p, "://") {
		return false
	}
	if strings.HasSuffix(p, "/") || strings.HasSuffix(p, `\`) {
		return false
	}
	base := p
	if i := strings.LastIndexAny(base, `/\`); i >= 0 {
		base = base[i+1:]
	}
	switch strings.ToLower(base) {
	case "", ".", "..", "e.g", "i.e":
		return false
	}
	dot := strings.LastIndexByte(base, '.')
	if dot < 0 {
		return false
	}
	ext := base[dot+1:]
	if ext == "" || len(ext) > 12 {
		return false
	}
	hasLetter := false
	for _, r := range ext {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			hasLetter = true
		case r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return false
		}
	}
	return hasLetter
}

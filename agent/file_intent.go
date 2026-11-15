package agent

import (
	"regexp"
	"strings"
	"unicode"
)

// fileWriteLeadRe matches the lead-in of "write/save/output [it] to|into <destination>".
// The destination itself is read by readWriteDestination, so that a quoted destination can
// hold spaces and an unquoted one ends at whitespace.
var fileWriteLeadRe = regexp.MustCompile(`(?i)(?:write(?:\s+down)?|save|output)\s+(?:it\s+)?(?:to|into)\s+`)

const fileWriteQuotes = "`\"'"

// ExtractFileWritePaths returns the explicit file destinations a task asks to write to, in
// the order they appear and without duplicates.
//
// A destination counts only when it is confidently a file:
//   - its last path element has an extension ("design/mobile-popups.md") or is a dotfile
//     (".env");
//   - it has no extension but is written in backticks or quotes ("`Makefile`"), is an
//     absolute, home or dot-relative path ("/tmp/out", "./build/output"), or is a file name
//     known to have none ("Makefile", "LICENSE").
//
// A directory ("design/", "`build` folder", "/tmp/out directory"), plain prose ("write down
// to the design/ folder", "save it to disk") and a URL name no file, so they return nothing
// and the run may choose its own file name. An extensionless path that turns out to be an
// existing directory is dropped later by the completion guard. An unquoted destination ends
// at whitespace; a destination in backticks or quotes may contain spaces. The case of a
// path is kept as written.
func ExtractFileWritePaths(task string) []string {
	t := strings.TrimSpace(task)
	if t == "" {
		return nil
	}

	var out []string
	seen := make(map[string]bool)
	for _, loc := range fileWriteLeadRe.FindAllStringIndex(t, -1) {
		d, ok := readWriteDestination(t[loc[1]:])
		if !ok || !isExplicitFilePath(d) || seen[d.path] {
			continue
		}
		seen[d.path] = true
		out = append(out, d.path)
	}
	return out
}

// writeDestination is what follows a write lead-in.
type writeDestination struct {
	path string
	// quoted says the path was written in backticks or quotes.
	quoted bool
	// after is the text that follows the destination.
	after string
}

// readWriteDestination reads the destination at the start of rest. A destination that opens
// with a quote runs to the same quote on the same line; one without a closing quote is
// malformed and is not a destination.
func readWriteDestination(rest string) (writeDestination, bool) {
	if rest == "" {
		return writeDestination{}, false
	}
	if quote := rest[0]; strings.IndexByte(fileWriteQuotes, quote) >= 0 {
		end := strings.IndexAny(rest[1:], string(quote)+"\r\n")
		if end < 0 || rest[1+end] != quote {
			return writeDestination{}, false
		}
		p := strings.TrimSpace(rest[1 : 1+end])
		return writeDestination{path: p, quoted: true, after: rest[end+2:]}, p != ""
	}
	after := ""
	if end := strings.IndexFunc(rest, func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune(fileWriteQuotes, r)
	}); end >= 0 {
		rest, after = rest[:end], rest[end:]
	}
	// Sentence punctuation around the path is not part of it.
	p := strings.TrimLeft(rest, "([{<")
	p = strings.TrimRight(p, ".,;:!?)]}>")
	return writeDestination{path: p, after: after}, p != ""
}

// isExplicitFilePath reports whether d confidently names a file rather than a directory or
// a word of the sentence.
func isExplicitFilePath(d writeDestination) bool {
	p := d.path
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
	if hasFileExtension(base) {
		return true
	}
	// No extension: a file only when the task marks it as a path and does not call it a
	// directory.
	if strings.Contains(base, ".") || isDirectoryWord(firstWord(d.after)) {
		return false
	}
	if d.quoted {
		words := strings.Fields(p)
		return !isDirectoryWord(strings.ToLower(words[len(words)-1]))
	}
	return isAnchoredPath(p) || extensionlessFileNames[base]
}

// hasFileExtension reports whether base ends in an extension; a dotfile counts.
func hasFileExtension(base string) bool {
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

// isAnchoredPath reports whether p is written as a path from a fixed place: absolute, from
// the home directory, or "./" and "../" relative. Prose is not written that way.
func isAnchoredPath(p string) bool {
	p = strings.ReplaceAll(p, `\`, "/")
	for _, prefix := range []string{"/", "./", "../", "~/"} {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	// A Windows drive path: C:/out.
	return len(p) > 3 && p[1] == ':' && p[2] == '/' &&
		(p[0] >= 'a' && p[0] <= 'z' || p[0] >= 'A' && p[0] <= 'Z')
}

// extensionlessFileNames are file names that are files without an extension. They match in
// their usual spelling only, so that prose ("save it to notice") is not read as one.
var extensionlessFileNames = map[string]bool{
	"Makefile": true, "makefile": true, "GNUmakefile": true, "Dockerfile": true,
	"Containerfile": true, "Jenkinsfile": true, "Vagrantfile": true, "Procfile": true,
	"Gemfile": true, "Rakefile": true, "Brewfile": true, "Pipfile": true, "Justfile": true,
	"justfile": true, "Caddyfile": true, "Tiltfile": true,
	"LICENSE": true, "LICENCE": true, "COPYING": true, "NOTICE": true, "README": true,
	"CHANGELOG": true, "AUTHORS": true, "CONTRIBUTORS": true, "CODEOWNERS": true,
	"VERSION": true,
}

// firstWord returns the first word of s in lower case, or "" when s does not start with
// one after its leading whitespace.
func firstWord(s string) string {
	s = strings.TrimLeftFunc(s, unicode.IsSpace)
	if end := strings.IndexFunc(s, func(r rune) bool { return !unicode.IsLetter(r) }); end >= 0 {
		s = s[:end]
	}
	return strings.ToLower(s)
}

// isDirectoryWord reports whether word calls the destination before it a directory.
func isDirectoryWord(word string) bool {
	switch word {
	case "folder", "folders", "subfolder", "directory", "directories", "subdirectory", "dir":
		return true
	}
	return false
}

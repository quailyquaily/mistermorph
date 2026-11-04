package guard

import (
	"regexp"
	"strings"
)

// streamRedactMaxBytes bounds what a StreamRedactor holds: the incomplete last line, and the
// complete lines it holds back while a match may still be open. Past it, the redactor cannot
// tell where a match would end, so it fails closed: the rest of the stream is hidden.
const streamRedactMaxBytes = 64 * 1024

// streamHiddenMarker replaces the rest of a stream the redactor could not check.
const streamHiddenMarker = "[rest of this output hidden: it could not be checked for secrets]\n"

var (
	streamKeyMarker = regexp.MustCompile(`-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----`)
	// A line ending like this may continue a match on the next line: the built-in patterns cross
	// a line break only through the \s in "bearer <token>" and "<key> : <value>".
	streamDangling = regexp.MustCompile(`(?i)(\bbearer|[:=])[ \t\r]*$`)
	// A quoted MISTER_MORPH_* value: the built-in pattern takes it up to the closing quote, which
	// may be lines later.
	streamEnvQuote = regexp.MustCompile(`\bMISTER_MORPH_[A-Za-z0-9_]{1,64}\s*[:=]\s*(["'])`)
)

// StreamRedactor redacts text that arrives in pieces, such as a command's output, the way an
// inline stream inspector does: it holds back only what could still become part of a match and
// releases the rest, redacted, as soon as it is safe. Fed a raw stream, what it shows equals
// redacting the whole text at once, up to where it fails closed.
//
//   - Text is released a line at a time, so a secret split across pieces is redacted whole.
//   - Complete lines are held while a match may continue past them: inside a private key block
//     (from BEGIN to END), after a line ending in ":", "=" or "bearer", inside a quoted
//     MISTER_MORPH_* value, and, with a custom pattern that may span lines ((?s) or \n),
//     until the stream ends.
//   - It never recovers from uncertainty. When the held lines or a single line pass
//     streamRedactMaxBytes, nothing held is released and the rest of the stream is hidden
//     behind one marker.
//   - At the end of the stream, what is held is released, redacted; a private key block that
//     never closed is hidden.
//
// A StreamRedactor is not safe for concurrent use.
type StreamRedactor struct {
	r *Redactor
	// holdAll is set when a custom pattern may span lines.
	holdAll bool
	// partial is the incomplete last line.
	partial strings.Builder
	// held are complete lines held back while a match may continue.
	held strings.Builder
	// The state of held, kept as lines arrive so held is never rescanned: its last non-blank
	// line, the quote of an open MISTER_MORPH_* value, and whether a private key block is open.
	heldLast  string
	heldQuote string
	inKey     bool
	// hidden is set once the rest of the stream is hidden.
	hidden bool
}

// NewStreamRedactor returns a redactor for one stream, or nil when Guard is off. Write and Flush
// on a nil StreamRedactor return their input unchanged.
func (g *Guard) NewStreamRedactor() *StreamRedactor {
	if !g.Enabled() || g.redactor == nil {
		return nil
	}
	return newStreamRedactor(g.redactor)
}

func newStreamRedactor(r *Redactor) *StreamRedactor {
	s := &StreamRedactor{r: r}
	for _, p := range r.patterns {
		if isBuiltinPattern(p.name) {
			continue
		}
		src := p.re.String()
		if strings.Contains(src, "(?s") || strings.Contains(src, `\n`) || strings.Contains(src, "\n") {
			s.holdAll = true
		}
	}
	return s
}

func isBuiltinPattern(name string) bool {
	switch name {
	case "private_key_block", "jwt_like", "bearer_line", "mister_morph_env_kv", "mister_morph_env_name", "simple_kv":
		return true
	}
	return false
}

// Write takes the next piece of the stream and returns the text that is now safe to show,
// redacted. It may return "" while text is held.
func (s *StreamRedactor) Write(chunk string) string {
	if s == nil {
		return chunk
	}
	var out strings.Builder
	for chunk != "" && !s.hidden {
		i := strings.IndexByte(chunk, '\n')
		piece := chunk
		if i >= 0 {
			piece = chunk[:i+1]
		}
		chunk = chunk[len(piece):]
		if s.partial.Len()+len(piece) > streamRedactMaxBytes {
			s.hide(&out)
			break
		}
		s.partial.WriteString(piece)
		if i < 0 {
			break
		}
		line := s.partial.String()
		s.partial.Reset()
		s.addLine(&out, line)
	}
	return out.String()
}

// Flush ends the stream and returns what is still held, redacted.
func (s *StreamRedactor) Flush() string {
	if s == nil || s.hidden {
		return ""
	}
	rest := s.held.String() + s.partial.String()
	s.resetHeld()
	s.partial.Reset()
	if rest == "" {
		return ""
	}
	redacted, _ := s.r.RedactString(cutUnclosedKey(rest))
	return redacted
}

// addLine holds one complete line, ending in "\n", and releases the held lines once no match
// can continue past them.
func (s *StreamRedactor) addLine(out *strings.Builder, line string) {
	s.held.WriteString(line)
	if s.held.Len() > streamRedactMaxBytes {
		s.hide(out)
		return
	}
	s.trackKey(line)
	s.trackQuote(line)
	if last := lastNonBlankLine(line); last != "" {
		s.heldLast = last
	}
	if s.holdAll || s.inKey || s.heldQuote != "" || streamDangling.MatchString(s.heldLast) {
		return
	}
	redacted, _ := s.r.RedactString(s.held.String())
	s.resetHeld()
	out.WriteString(redacted)
}

// trackKey follows the private key markers in line, in order, as the built-in pattern pairs
// them: a BEGIN opens a block and the next END closes it.
func (s *StreamRedactor) trackKey(line string) {
	for _, m := range streamKeyMarker.FindAllStringSubmatch(line, -1) {
		s.inKey = m[1] == "BEGIN"
	}
}

// trackQuote follows quoted MISTER_MORPH_* values: an open one closes at its quote, and another
// may open after it.
func (s *StreamRedactor) trackQuote(line string) {
	scan := line
	if s.heldQuote != "" {
		i := strings.Index(scan, s.heldQuote)
		if i < 0 {
			return
		}
		s.heldQuote = ""
		scan = scan[i+1:]
	} else if s.heldLast != "" {
		// The key and its separator may be on the line before the opening quote.
		scan = s.heldLast + "\n" + scan
	}
	s.heldQuote = openEnvQuoteChar(scan)
}

// hide fails closed: nothing held is released, and the rest of the stream is dropped.
func (s *StreamRedactor) hide(out *strings.Builder) {
	s.resetHeld()
	s.partial.Reset()
	s.hidden = true
	out.WriteString(streamHiddenMarker)
}

func (s *StreamRedactor) resetHeld() {
	s.held.Reset()
	s.heldLast = ""
	s.heldQuote = ""
	s.inKey = false
}

// cutUnclosedKey hides a private key block that never closes, from its BEGIN marker on.
func cutUnclosedKey(text string) string {
	open := -1
	for _, m := range streamKeyMarker.FindAllStringSubmatchIndex(text, -1) {
		if text[m[2]:m[3]] == "BEGIN" {
			if open < 0 {
				open = m[0]
			}
		} else {
			open = -1
		}
	}
	if open < 0 {
		return text
	}
	return text[:open] + "[redacted private key]\n"
}

func lastNonBlankLine(text string) string {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			return strings.TrimRight(lines[i], "\r")
		}
	}
	return ""
}

// openEnvQuoteChar returns the quote of a MISTER_MORPH_* value in text that has not closed.
func openEnvQuoteChar(text string) string {
	offset := 0
	for {
		m := streamEnvQuote.FindStringSubmatchIndex(text[offset:])
		if m == nil {
			return ""
		}
		quote := text[offset+m[2] : offset+m[3]]
		after := offset + m[1]
		closing := strings.Index(text[after:], quote)
		if closing < 0 {
			return quote
		}
		offset = after + closing + 1
	}
}

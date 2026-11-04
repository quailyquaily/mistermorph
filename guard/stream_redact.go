package guard

import (
	"regexp"
	"strings"
)

// Limits for StreamRedactor. A held private key block or a line longer than these is not
// released: the redactor fails closed and shows a marker instead.
const (
	streamRedactMaxLineBytes = 64 * 1024
	streamRedactMaxKeyBytes  = 16 * 1024
	streamRedactMaxHeldBytes = 64 * 1024
)

const (
	streamRedactedKeyMarker  = "[redacted private key]\n"
	streamRedactedLongMarker = "[line over 64 KB hidden]\n"
	streamRedactedHeldMarker = "[held output over 64 KB hidden]\n"
	streamRedactedRestMarker = "[rest of output hidden: a multi-line redaction pattern may still be open]\n"
)

var (
	streamKeyBegin = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	streamKeyEnd   = regexp.MustCompile(`-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	// A line ending like this may continue a match on the next line: the built-in patterns cross
	// a line break only through the \s in "bearer <token>" and "<key> : <value>".
	streamDangling = regexp.MustCompile(`(?i)(\bbearer|[:=])[ \t\r]*$`)
	// A quoted MISTER_MORPH_* value: the built-in pattern takes it up to the closing quote, which
	// may be lines later.
	streamEnvQuote = regexp.MustCompile(`\bMISTER_MORPH_[A-Za-z0-9_]{1,64}\s*[:=]\s*(["'])`)
	// The body of a PEM block: base64 and blank lines.
	streamKeyBody = regexp.MustCompile(`^[A-Za-z0-9+/=\r]*\n?$`)
)

// StreamRedactor redacts text that arrives in pieces, such as a command's output, the way an
// inline stream inspector does: it holds back only what could still become part of a match and
// releases the rest, redacted, as soon as it is safe. Fed the raw text, its output equals
// redacting the whole text at once, except where it fails closed.
//
//   - Text is released a line at a time, so a secret split across pieces is redacted whole.
//   - Lines are held while a match may continue on the next line: the last non-blank line ends
//     in ":", "=" or "bearer" (the built-in patterns cross a line break only through the
//     whitespace after those), or a quoted MISTER_MORPH_* value has not closed.
//   - A private key block is held from its BEGIN line to its END line and redacted as a whole.
//     One that is not closed within streamRedactMaxKeyBytes, or by the end of the stream, is
//     replaced by a marker, including its last line; the rest of an over-long block is dropped
//     up to its END line or the first line that is not base64.
//   - A line over streamRedactMaxLineBytes is dropped and replaced by a marker.
//   - With a custom pattern that may span lines ((?s) or \n), the stream is held to its end.
//   - Held text past streamRedactMaxHeldBytes is dropped and replaced by a marker, since a
//     match in it may still be open, and so is the rest of that match: the rest of a quoted
//     value up to its closing quote, or, with a multi-line custom pattern, the rest of the
//     stream.
//
// A StreamRedactor is not safe for concurrent use.
type StreamRedactor struct {
	r *Redactor
	// holdAll is set when a custom pattern may span lines.
	holdAll bool
	// partial is the incomplete last line.
	partial strings.Builder
	// skipLine drops the rest of an over-long line, up to its newline.
	skipLine bool
	// held are complete lines waiting for the next line (dangling) or for the stream end (holdAll).
	held strings.Builder
	// heldLast is the last non-blank line in held, and heldQuote the quote of a MISTER_MORPH_*
	// value in held that has not closed; both are kept as lines arrive, so held is not rescanned.
	heldLast  string
	heldQuote string
	// key is a private key block waiting for its END line; inKey is set while it is open.
	key   strings.Builder
	inKey bool
	// skipKey drops the rest of a key block that grew too long: its base64 lines, up to its END
	// line or the first line that is not key material.
	skipKey bool
	// skipQuote, when set, drops the rest of a quoted value that grew too long, up to and
	// including this closing quote.
	skipQuote string
	// hideRest drops the rest of the stream: held text grew too long while a multi-line custom
	// pattern may have been open.
	hideRest bool
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
	if s.hideRest {
		return ""
	}
	var out strings.Builder
	for chunk != "" {
		i := strings.IndexByte(chunk, '\n')
		if i < 0 {
			s.addPartial(&out, chunk)
			break
		}
		piece := chunk[:i+1]
		chunk = chunk[i+1:]
		if s.skipLine {
			s.skipLine = false
			continue
		}
		if s.partial.Len()+len(piece) > streamRedactMaxLineBytes+1 {
			s.dropLongLine(&out)
			s.skipLine = false
			continue
		}
		s.partial.WriteString(piece)
		line := s.partial.String()
		s.partial.Reset()
		s.line(&out, line)
	}
	return out.String()
}

// Flush ends the stream and returns what is still held, redacted. A private key block that never
// closed is not shown.
func (s *StreamRedactor) Flush() string {
	if s == nil {
		return ""
	}
	if s.hideRest {
		s.resetHeld()
		s.partial.Reset()
		return ""
	}
	var out strings.Builder
	if s.inKey {
		// The unfinished block includes its last line, even without a newline.
		s.key.Reset()
		s.inKey = false
		s.resetHeld()
		s.partial.Reset()
		out.WriteString(streamRedactedKeyMarker)
	}
	if s.skipKey {
		s.skipKey = false
		if streamKeyBody.MatchString(s.partial.String()) {
			s.partial.Reset()
		}
	}
	if s.skipQuote != "" {
		partial := s.partial.String()
		s.partial.Reset()
		if i := strings.Index(partial, s.skipQuote); i >= 0 {
			s.partial.WriteString(partial[i+1:])
		}
		s.skipQuote = ""
	}
	rest := s.held.String() + s.partial.String()
	s.resetHeld()
	s.partial.Reset()
	s.skipLine = false
	if rest != "" {
		redacted, _ := s.r.RedactString(cutUnclosedKey(rest))
		out.WriteString(redacted)
	}
	return out.String()
}

// cutUnclosedKey replaces a private key block that never closes, from its BEGIN marker on.
func cutUnclosedKey(text string) string {
	offset := 0
	for {
		begin := streamKeyBegin.FindStringIndex(text[offset:])
		if begin == nil {
			return text
		}
		start, end := offset+begin[0], offset+begin[1]
		closing := streamKeyEnd.FindStringIndex(text[end:])
		if closing == nil {
			return text[:start] + streamRedactedKeyMarker
		}
		offset = end + closing[1]
	}
}

func (s *StreamRedactor) addPartial(out *strings.Builder, text string) {
	if s.skipLine {
		return
	}
	s.partial.WriteString(text)
	if s.partial.Len() <= streamRedactMaxLineBytes {
		return
	}
	s.dropLongLine(out)
}

// dropLongLine fails closed on a line too long to hold: any cut could split a secret, so the
// line is not shown.
func (s *StreamRedactor) dropLongLine(out *strings.Builder) {
	s.partial.Reset()
	s.skipLine = true
	if s.inKey || s.skipKey {
		if s.inKey {
			out.WriteString(streamRedactedKeyMarker)
		}
		s.key.Reset()
		s.inKey = false
		s.skipKey = true
		return
	}
	s.releaseHeld(out)
	out.WriteString(streamRedactedLongMarker)
}

// line handles one complete line, ending in "\n".
func (s *StreamRedactor) line(out *strings.Builder, line string) {
	if s.hideRest {
		return
	}
	if s.skipQuote != "" {
		i := strings.Index(line, s.skipQuote)
		if i < 0 {
			return
		}
		s.skipQuote = ""
		line = line[i+1:]
		if strings.TrimSpace(line) == "" {
			return
		}
	}
	if s.skipKey {
		if end := streamKeyEnd.FindStringIndex(line); end != nil {
			s.skipKey = false
			line = line[end[1]:]
			if strings.TrimSpace(line) == "" {
				return
			}
		} else if streamKeyBody.MatchString(line) {
			return
		} else {
			s.skipKey = false
		}
	}
	if s.inKey {
		s.key.WriteString(line)
		if streamKeyEnd.MatchString(line) {
			block := s.key.String()
			s.key.Reset()
			s.inKey = false
			s.hold(out, block)
			return
		}
		if s.key.Len() > streamRedactMaxKeyBytes {
			s.key.Reset()
			s.inKey = false
			s.skipKey = true
			out.WriteString(streamRedactedKeyMarker)
		}
		return
	}
	if begin := streamKeyBegin.FindStringIndex(line); begin != nil && !streamKeyEnd.MatchString(line[begin[1]:]) {
		// The block, and anything held before it, waits for the END line.
		s.key.WriteString(s.held.String())
		s.resetHeld()
		s.key.WriteString(line)
		s.inKey = true
		return
	}
	s.hold(out, line)
}

// hold adds complete text to the held lines and releases them unless they may continue.
func (s *StreamRedactor) hold(out *strings.Builder, text string) {
	s.addHeld(text)
	if !s.holdAll && !s.mayContinue() {
		s.releaseHeld(out)
		return
	}
	if s.held.Len() > streamRedactMaxHeldBytes {
		s.hideHeld(out)
	}
}

// hideHeld fails closed on held text that grew too long while a match in it may still be open:
// releasing any of it could split a secret. It is dropped, and so is what remains of the open
// match.
func (s *StreamRedactor) hideHeld(out *strings.Builder) {
	quote, last := s.heldQuote, s.heldLast
	s.resetHeld()
	if s.holdAll {
		// A custom match may end anywhere later, so nothing more is safe to show.
		s.hideRest = true
		out.WriteString(streamRedactedRestMarker)
		return
	}
	out.WriteString(streamRedactedHeldMarker)
	if quote != "" {
		s.skipQuote = quote
		return
	}
	// The line that may continue stays as context, so its value is still redacted with it.
	if last != "" {
		s.addHeld(last + "\n")
	}
}

func (s *StreamRedactor) resetHeld() {
	s.held.Reset()
	s.heldLast = ""
	s.heldQuote = ""
}

// addHeld appends complete lines to held and updates heldLast and heldQuote from them alone.
func (s *StreamRedactor) addHeld(text string) {
	s.held.WriteString(text)
	if s.holdAll {
		return
	}
	scan := text
	if s.heldQuote != "" {
		i := strings.Index(scan, s.heldQuote)
		if i < 0 {
			return
		}
		s.heldQuote = ""
		scan = scan[i+1:]
	} else if s.heldLast != "" {
		// A key and its separator may be on the line before the opening quote.
		scan = s.heldLast + "\n" + scan
	}
	s.heldQuote = openEnvQuoteChar(scan)
	if last := lastNonBlankLine(text); last != "" {
		s.heldLast = last
	}
}

// mayContinue reports whether a match in the held lines may continue on the next line: the last
// non-blank line ends in ":", "=" or "bearer", or a quoted MISTER_MORPH_* value is still open.
func (s *StreamRedactor) mayContinue() bool {
	return s.heldQuote != "" || (s.heldLast != "" && streamDangling.MatchString(s.heldLast))
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

func (s *StreamRedactor) releaseHeld(out *strings.Builder) {
	if s.held.Len() == 0 {
		return
	}
	redacted, _ := s.r.RedactString(s.held.String())
	s.resetHeld()
	out.WriteString(redacted)
}

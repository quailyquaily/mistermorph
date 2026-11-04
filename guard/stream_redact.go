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
)

var (
	streamKeyBegin = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	streamKeyEnd   = regexp.MustCompile(`-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	// A line ending like this may continue a match on the next line: the built-in patterns cross
	// a line break only through the \s in "bearer <token>" and "<key> : <value>".
	streamDangling = regexp.MustCompile(`(?i)(\bbearer|[:=])[ \t\r]*$`)
	// The body of a PEM block: base64 and blank lines.
	streamKeyBody = regexp.MustCompile(`^[A-Za-z0-9+/=\r]*\n?$`)
)

// StreamRedactor redacts text that arrives in pieces, such as a command's output, the way an
// inline stream inspector does: it holds back only what could still become part of a match and
// releases the rest, redacted, as soon as it is safe.
//
//   - Text is released a line at a time, so a secret split across pieces is redacted whole.
//   - A line ending in ":", "=" or "bearer" is held until the next non-blank line, since a
//     key/value or bearer token may continue there.
//   - A private key block is held from its BEGIN line to its END line and redacted as a whole.
//     One that is not closed within streamRedactMaxKeyBytes, or by the end of the stream, is
//     replaced by a marker; the rest of an over-long block is dropped up to its END line or the
//     first line that is not base64.
//   - A line over streamRedactMaxLineBytes is dropped and replaced by a marker.
//   - With a custom pattern that may span lines ((?s) or \n), the stream is held and redacted
//     in blocks of streamRedactMaxHeldBytes, and at its end.
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
	// key is a private key block waiting for its END line; inKey is set while it is open.
	key   strings.Builder
	inKey bool
	// skipKey drops the rest of a key block that grew too long: its base64 lines, up to its END
	// line or the first line that is not key material.
	skipKey bool
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
	var out strings.Builder
	if s.inKey {
		s.key.Reset()
		s.inKey = false
		s.held.Reset()
		out.WriteString(streamRedactedKeyMarker)
	}
	if s.skipKey {
		s.skipKey = false
		if streamKeyBody.MatchString(s.partial.String()) {
			s.partial.Reset()
		}
	}
	rest := s.held.String() + s.partial.String()
	s.held.Reset()
	s.partial.Reset()
	s.skipLine = false
	if rest != "" {
		redacted, _ := s.r.RedactString(rest)
		out.WriteString(redacted)
	}
	return out.String()
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
		s.held.Reset()
		s.key.WriteString(line)
		s.inKey = true
		return
	}
	s.hold(out, line)
}

// hold adds complete text to the held lines and releases them unless they may continue.
func (s *StreamRedactor) hold(out *strings.Builder, text string) {
	s.held.WriteString(text)
	if s.holdAll {
		// Held in blocks: a multi-line custom match can be split only where a block ends.
		if s.held.Len() > streamRedactMaxHeldBytes {
			s.releaseHeld(out)
		}
		return
	}
	last := lastLine(text)
	if strings.TrimSpace(last) == "" || streamDangling.MatchString(strings.TrimRight(last, "\n")) {
		if s.held.Len() <= streamRedactMaxHeldBytes {
			return
		}
	}
	s.releaseHeld(out)
}

func (s *StreamRedactor) releaseHeld(out *strings.Builder) {
	if s.held.Len() == 0 {
		return
	}
	redacted, _ := s.r.RedactString(s.held.String())
	s.held.Reset()
	out.WriteString(redacted)
}

func lastLine(text string) string {
	trimmed := strings.TrimSuffix(text, "\n")
	if i := strings.LastIndexByte(trimmed, '\n'); i >= 0 {
		return trimmed[i+1:]
	}
	return trimmed
}

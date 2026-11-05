package guard

import "regexp"

// A private key block's first and last lines, as the built-in block pattern knows them.
var (
	privateKeyBeginRe = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	privateKeyEndRe   = regexp.MustCompile(`-----END [A-Z0-9 ]*PRIVATE KEY-----`)
)

// redactedPrivateKeyPart stands for a private key block of which the text holds only a part.
const redactedPrivateKeyPart = "[redacted private key]"

// RedactCompleteOutput redacts one complete piece of output for a transient view: a command's
// whole output, a whole message, a whole tool input or result. It is RedactString, and it also
// hides a private key block the piece holds only a part of, which no pattern matches.
//
// The piece must be complete and exactly the text that will be shown. Redaction looks at the
// text it is given and no further, so pieces of a longer text, or a text that is changed or cut
// afterwards, would not get what the whole text gets. Cut a preview from the result, not before.
func (g *Guard) RedactCompleteOutput(content string) string {
	if !g.Enabled() || g.redactor == nil {
		return content
	}
	return g.redactor.RedactComplete(content)
}

// RedactComplete is RedactString for a text that is complete: see Guard.RedactCompleteOutput.
func (r *Redactor) RedactComplete(s string) string {
	if r == nil {
		return s
	}
	redacted, _ := r.RedactString(s)
	return hidePrivateKeyParts(redacted, r.find("private_key_block"))
}

// hidePrivateKeyParts hides what a complete text holds of private key blocks that are not whole
// in it. An END line without its BEGIN closes a block that began before the text, so the text
// is hidden up to it. A BEGIN line without its END opens a block that the text does not finish,
// so the text is hidden from it on. Whole blocks are redacted before this and stay as they are.
func hidePrivateKeyParts(s string, block *regexp.Regexp) string {
	var whole [][]int
	if block != nil {
		whole = block.FindAllStringIndex(s, -1)
	}
	inWhole := func(at int) bool {
		for _, span := range whole {
			if at >= span[0] && at < span[1] {
				return true
			}
		}
		return false
	}
	from := 0
	for _, end := range privateKeyEndRe.FindAllStringIndex(s, -1) {
		if !inWhole(end[0]) {
			from = end[1]
		}
	}
	to := len(s)
	for _, begin := range privateKeyBeginRe.FindAllStringIndex(s, -1) {
		if begin[0] >= from && !inWhole(begin[0]) {
			to = begin[0]
			break
		}
	}
	if from == 0 && to == len(s) {
		return s
	}
	out := s[from:to]
	if from > 0 {
		out = redactedPrivateKeyPart + out
	}
	if to < len(s) {
		out += redactedPrivateKeyPart
	}
	return out
}

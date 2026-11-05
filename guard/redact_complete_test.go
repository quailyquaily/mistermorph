package guard

import (
	"strings"
	"testing"
)

const (
	testKeyBegin = "-----BEGIN RSA PRIVATE KEY-----"
	testKeyEnd   = "-----END RSA PRIVATE KEY-----"
	testKeyBody  = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo\n4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onL\n"
)

func completeOutputGuard(patterns ...RegexPattern) *Guard {
	return New(Config{Enabled: true, Redaction: RedactionConfig{Enabled: len(patterns) > 0, Patterns: patterns}}, nil, nil)
}

// A complete text gets exactly what RedactString gives it, unless it holds part of a key block.
func TestRedactCompleteOutputEqualsRedactString(t *testing.T) {
	g := completeOutputGuard(RegexPattern{Name: "block", Re: `(?s)<secret>.*?</secret>`})
	for _, text := range []string{
		"",
		"   \n",
		"nothing to hide here\n",
		"token: abcdefghijklmnopqrstuvwx and more\n",
		"api_key=\nabcdefghijklmnopqrstuvwx\n",
		"api_key=\f\nabcdefghijklmnopqrstuvwx\n",
		"Authorization: Bearer \n\n abcdefghijklmnopqrstuvwx\n",
		"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end\n",
		"MISTER_MORPH_API_KEY=\"first line\nsecondSECRET123456\" rest\n",
		"a <secret>\nSENSITIVEPAYLOAD123456\n</secret> b\n",
		"before\n" + testKeyBegin + "\n" + testKeyBody + testKeyEnd + "\nafter password=abcdefghijklmnop\n",
		strings.Repeat("x", 200_000) + " password=abcdefghijklmnop " + strings.Repeat("y", 200_000) + "\n",
	} {
		want, _ := g.RedactString(text)
		if got := g.RedactCompleteOutput(text); got != want {
			t.Errorf("RedactCompleteOutput(%.40q) = %.80q, want RedactString's %.80q", text, got, want)
		}
	}
}

func TestRedactCompleteOutputHidesPartsOfPrivateKeyBlocks(t *testing.T) {
	g := completeOutputGuard(RegexPattern{Name: "block", Re: `(?s)<secret>.*?</secret>`})
	body := "SENSITIVEPAYLOAD123456\n"
	big := strings.Repeat("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n", 8000) // about 300 KB
	for _, tc := range []struct {
		name string
		text string
		want string
	}{
		{"whole block", "a\n" + testKeyBegin + "\n" + body + testKeyEnd + "\nz\n", "a\n-----BEGIN PRIVATE KEY-----\n[redacted]\n-----END PRIVATE KEY-----\nz\n"},
		{"no END", "a\n" + testKeyBegin + "\n" + body, "a\n[redacted private key]"},
		{"no END, no line break after BEGIN", "a\n" + testKeyBegin, "a\n[redacted private key]"},
		{"no END, body without a line break", "a\n" + testKeyBegin + "\nSENSITIVEPAYLOAD123456", "a\n[redacted private key]"},
		{"no BEGIN", body + testKeyEnd + "\nz\n", "[redacted private key]\nz\n"},
		{"END of one, BEGIN of the next", body + testKeyEnd + "\nmiddle\n" + testKeyBegin + "\n" + body, "[redacted private key]\nmiddle\n[redacted private key]"},
		{"END and BEGIN on one line", testKeyBegin + "\n" + body + testKeyEnd + testKeyBegin + "\n" + body, "-----BEGIN PRIVATE KEY-----\n[redacted]\n-----END PRIVATE KEY-----[redacted private key]"},
		{"whole block, then no END", testKeyBegin + "\n" + body + testKeyEnd + "\nmiddle\n" + testKeyBegin + "\n" + body, "-----BEGIN PRIVATE KEY-----\n[redacted]\n-----END PRIVATE KEY-----\nmiddle\n[redacted private key]"},
		{"oversized whole block", "a\n" + testKeyBegin + "\n" + big + body + testKeyEnd + "\nz\n", "a\n-----BEGIN PRIVATE KEY-----\n[redacted]\n-----END PRIVATE KEY-----\nz\n"},
		{"oversized, no END", "a\n" + testKeyBegin + "\n" + big + body, "a\n[redacted private key]"},
		// The enclosing match is redacted first, whole, so its closing delimiter is still there
		// when the key's BEGIN inside it is looked at.
		{"no END inside a custom block", "a <secret>\n" + body + testKeyBegin + "\n" + body + "</secret> z\n", "a [redacted] z\n"},
		{"no END inside a quoted value", "MISTER_MORPH_X=\"" + body + testKeyBegin + "\n" + body + "\" z\n", "[redacted_env]=[redacted] z\n"},
		{"quote inside a block inside a quoted value", "MISTER_MORPH_X=\"" + testKeyBegin + "\nab\"cd\n" + testKeyEnd + "\n" + body + "\" z\n", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := g.RedactCompleteOutput(tc.text)
			if strings.Contains(got, "SENSITIVEPAYLOAD") || strings.Contains(got, "QUJDREVG") {
				t.Fatalf("key material shown: %.200q", got)
			}
			if tc.want == "" {
				// Whatever whole-text redaction gives, with the key gone.
				tc.want, _ = g.RedactString(tc.text)
			}
			if got != tc.want {
				t.Fatalf("got %.200q, want %.200q", got, tc.want)
			}
		})
	}
}

func TestRedactCompleteOutputWithGuardOff(t *testing.T) {
	text := "password=abcdefghijklmnop\n" + testKeyBegin + "\nSENSITIVEPAYLOAD123456\n"
	var none *Guard
	for name, g := range map[string]*Guard{"nil": none, "disabled": New(Config{}, nil, nil)} {
		if got := g.RedactCompleteOutput(text); got != text {
			t.Errorf("%s guard changed the text: %q", name, got)
		}
	}
	var r *Redactor
	if got := r.RedactComplete(text); got != text {
		t.Errorf("nil redactor changed the text: %q", got)
	}
}

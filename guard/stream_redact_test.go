package guard

import (
	"strings"
	"testing"
)

func newTestStreamRedactor(t *testing.T, patterns ...RegexPattern) *StreamRedactor {
	t.Helper()
	g := New(Config{Enabled: true, Redaction: RedactionConfig{Enabled: true, Patterns: patterns}}, nil, nil)
	s := g.NewStreamRedactor()
	if s == nil {
		t.Fatal("no stream redactor with Guard on")
	}
	return s
}

// feed writes text in pieces of size n and returns everything shown, and what was shown before
// the flush.
func feed(s *StreamRedactor, text string, n int) (all, beforeFlush string) {
	var out strings.Builder
	for len(text) > 0 {
		k := n
		if k > len(text) {
			k = len(text)
		}
		out.WriteString(s.Write(text[:k]))
		text = text[k:]
	}
	beforeFlush = out.String()
	out.WriteString(s.Flush())
	return out.String(), beforeFlush
}

const (
	testJWT    = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl"
	testBearer = "abcdefghijklmnopqrstuvwxyz0123456789"
	testKV     = "s3cr3tVALUEs3cr3tVALUE"
	testEnv    = "mm-env-secret-value-123456"
	testKey    = "MIIEowIBAAKCAQEAsecretkeymaterialsecretkeymaterial"
)

var testSecrets = []string{testJWT, testBearer, testKV, testEnv, testKey, "secretkeymaterial"}

func assertNoSecret(t *testing.T, label, shown string) {
	t.Helper()
	for _, secret := range testSecrets {
		// Any 8 characters of a secret count as showing part of it.
		for i := 0; i+8 <= len(secret); i++ {
			if strings.Contains(shown, secret[i:i+8]) {
				t.Fatalf("%s: shows part of %q: %q", label, secret, shown)
			}
		}
	}
}

func TestStreamRedactorRedactsSecretsSplitAcrossChunks(t *testing.T) {
	text := "start\n" +
		"jwt " + testJWT + " end\n" +
		"Authorization: Bearer " + testBearer + "\n" +
		"api_key=" + testKV + "\n" +
		"MISTER_MORPH_LLM_API_KEY=" + testEnv + "\n" +
		"MISTER_MORPH_TOKEN=\"first" + testEnv + "\nsecond" + testKV + "\"\n" +
		"-----BEGIN RSA PRIVATE KEY-----\n" + testKey + "\n" + testKey + "\n-----END RSA PRIVATE KEY-----\n" +
		"password:\n\n   " + testKV + "\n" +
		"done\n"
	want, _ := New(Config{Enabled: true}, nil, nil).RedactString(text)
	for n := 1; n <= len(text); n++ {
		s := newTestStreamRedactor(t)
		all, _ := feed(s, text, n)
		assertNoSecret(t, "chunk size "+itoa(n), all)
		if all != want {
			t.Fatalf("chunk size %d:\n got %q\nwant %q", n, all, want)
		}
	}
}

func TestStreamRedactorReleasesLinesAsTheyComplete(t *testing.T) {
	s := newTestStreamRedactor(t)
	if got := s.Write("first li"); got != "" {
		t.Fatalf("partial line shown: %q", got)
	}
	if got := s.Write("ne\nsecond"); got != "first line\n" {
		t.Fatalf("got %q", got)
	}
	if got := s.Flush(); got != "second" {
		t.Fatalf("flush = %q", got)
	}
}

func TestStreamRedactorHoldsWhileAMatchMayContinue(t *testing.T) {
	for _, tc := range []struct{ name, first, rest string }{
		{"separator at line end", "api_key =\n", "\n" + testKV + "\nafter\n"},
		{"bearer at line end", "Authorization: Bearer \n", testBearer + "\n"},
		{"open quoted value", "MISTER_MORPH_API_KEY='" + testEnv + "\n", testKV + "'\n"},
		{"open key block", "-----BEGIN EC PRIVATE KEY-----\n", testKey + "\n-----END EC PRIVATE KEY-----\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestStreamRedactor(t)
			if got := s.Write(tc.first); got != "" {
				t.Fatalf("released early: %q", got)
			}
			all, _ := feed(s, tc.rest, 3)
			assertNoSecret(t, tc.name, all)
			want, _ := New(Config{Enabled: true}, nil, nil).RedactString(tc.first + tc.rest)
			if all != want {
				t.Fatalf("got %q, want %q", all, want)
			}
		})
	}
}

func TestStreamRedactorPrivateKeyBlocks(t *testing.T) {
	block := "-----BEGIN OPENSSH PRIVATE KEY-----\n" + testKey + "\n"
	t.Run("text after END is shown", func(t *testing.T) {
		s := newTestStreamRedactor(t)
		all, _ := feed(s, "before\n"+block+"-----END OPENSSH PRIVATE KEY----- tail\n", 5)
		assertNoSecret(t, "complete", all)
		if !strings.HasPrefix(all, "before\n") || !strings.HasSuffix(all, " tail\n") {
			t.Fatalf("got %q", all)
		}
	})
	// Review finding: the last line of an unclosed block leaked when it had no newline.
	for _, tc := range []struct{ name, text string }{
		{"unclosed", "before\n" + block + testKey + "\n"},
		{"unclosed, last line without newline", "before\n" + block + testKey},
		{"unclosed, BEGIN without newline", "before\n-----BEGIN RSA PRIVATE KEY-----" + testKey},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestStreamRedactor(t)
			all, _ := feed(s, tc.text, 7)
			assertNoSecret(t, tc.name, all)
			if all != "before\n[redacted private key]\n" {
				t.Fatalf("got %q", all)
			}
		})
	}
	// Review note: END and the next BEGIN on one line.
	t.Run("END and BEGIN on one line", func(t *testing.T) {
		s := newTestStreamRedactor(t)
		text := block + "-----END RSA PRIVATE KEY----------BEGIN RSA PRIVATE KEY-----\nSENSITIVEPAYLOAD123456\n-----END RSA PRIVATE KEY-----\nafter\n"
		all, _ := feed(s, text, 9)
		if strings.Contains(all, "SENSITIVEPAYLOAD") || strings.Contains(all, "secretkeymaterial") || !strings.HasSuffix(all, "after\n") {
			t.Fatalf("got %q", all)
		}
	})
	t.Run("over the limit", func(t *testing.T) {
		s := newTestStreamRedactor(t)
		long := block + strings.Repeat(testKey+"\n", streamRedactMaxBytes/len(testKey)+2)
		all, _ := feed(s, "before\n"+long+"-----END OPENSSH PRIVATE KEY-----\nafter\n", 1024)
		assertNoSecret(t, "over the limit", all)
		if all != "before\n"+streamHiddenMarker {
			t.Fatalf("got %q", all)
		}
	})
}

// Review findings: dropping a long line or an oversized key reset an open match, and its rest
// was shown. The redactor now hides the rest of the stream instead.
func TestStreamRedactorHidesTheRestWhenItCannotTell(t *testing.T) {
	custom := RegexPattern{Name: "block", Re: `(?s)<secret>.*?</secret>`}
	for _, tc := range []struct {
		name     string
		patterns []RegexPattern
		text     string
	}{
		{"long line inside a custom block", []RegexPattern{custom},
			"ok\n<secret>\nSENSITIVEPAYLOAD123456\n" + strings.Repeat("x", 65537) + "\n</secret>\nafter\n"},
		{"long line inside a quoted value", nil,
			"ok\nMISTER_MORPH_API_KEY=\"" + testEnv + "\n" + strings.Repeat("x", 65537) + "\nSENSITIVEPAYLOAD123456\"\nafter\n"},
		{"long line inside a key block", nil,
			"ok\n-----BEGIN RSA PRIVATE KEY-----\n" + strings.Repeat("x", 65537) + "\nSENSITIVEPAYLOAD123456\n-----END RSA PRIVATE KEY-----\nafter\n"},
		{"held text past the limit", []RegexPattern{custom},
			strings.Repeat("safe\n", 13105) + "<secret>\nSENSITIVEPAYLOAD123456\n</secret>\nafter\n"},
		{"long line", nil, "ok\ntoken=" + testKV + strings.Repeat("x", 65537) + "\nSENSITIVEPAYLOAD123456\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestStreamRedactor(t, tc.patterns...)
			all, _ := feed(s, tc.text, 4096)
			assertNoSecret(t, tc.name, all)
			if strings.Contains(all, "SENSITIVEPAYLOAD") || strings.Contains(all, "after") {
				t.Fatalf("shown after the marker: ...%q", all[max(0, len(all)-200):])
			}
			if !strings.HasSuffix(all, streamHiddenMarker) {
				t.Fatalf("no marker: ...%q", all[max(0, len(all)-200):])
			}
			if got := s.Write("more\n"); got != "" {
				t.Fatalf("shown after hiding: %q", got)
			}
		})
	}
}

func TestStreamRedactorCustomPatterns(t *testing.T) {
	t.Run("single line", func(t *testing.T) {
		s := newTestStreamRedactor(t, RegexPattern{Name: "ticket", Re: `TICKET-[0-9]{6}`})
		all, _ := feed(s, "see TICKET-123456 now\n", 2)
		if all != "see [redacted] now\n" {
			t.Fatalf("got %q", all)
		}
	})
	t.Run("multi line is held to the end", func(t *testing.T) {
		s := newTestStreamRedactor(t, RegexPattern{Name: "block", Re: `(?s)<secret>.*?</secret>`})
		all, before := feed(s, "a\n<secret>\n"+testKV+"\n</secret>\nb\n", 3)
		assertNoSecret(t, "multi line", all)
		if before != "" || all != "a\n[redacted]\nb\n" {
			t.Fatalf("before %q, all %q", before, all)
		}
	})
	// Review finding: an oversized key inside a custom block ended the block's protection.
	t.Run("key block inside a custom block", func(t *testing.T) {
		s := newTestStreamRedactor(t, RegexPattern{Name: "block", Re: `(?s)<secret>.*?</secret>`})
		key := "-----BEGIN RSA PRIVATE KEY-----\n" + strings.Repeat(testKey+"\n", 400) + "-----END RSA PRIVATE KEY-----\n"
		all, _ := feed(s, "<secret>\n"+key+"SENSITIVEPAYLOAD123456\n</secret>\nafter\n", 1000)
		if strings.Contains(all, "SENSITIVEPAYLOAD") || strings.Contains(all, "secretkeymaterial") || all != "[redacted]\nafter\n" {
			t.Fatalf("got %q", all[:min(len(all), 300)])
		}
	})
}

func TestStreamRedactorIsOffWithoutGuard(t *testing.T) {
	g := New(Config{Enabled: false}, nil, nil)
	s := g.NewStreamRedactor()
	if s != nil {
		t.Fatal("stream redactor with Guard off")
	}
	if got := s.Write("api_key=" + testKV); got != "api_key="+testKV {
		t.Fatalf("nil redactor changed text: %q", got)
	}
	if got := s.Flush(); got != "" {
		t.Fatalf("nil flush = %q", got)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

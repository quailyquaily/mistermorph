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
		"-----BEGIN RSA PRIVATE KEY-----\n" + testKey + "\n" + testKey + "\n-----END RSA PRIVATE KEY-----\n" +
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

func TestStreamRedactorHoldsLinesThatMayContinue(t *testing.T) {
	for _, tc := range []struct{ name, text string }{
		{"key and value on separate lines", "password:\n\n   " + testKV + "\nafter\n"},
		{"equals at line end", "api_key =\n" + testKV + "\n"},
		{"bearer at line end", "Authorization: Bearer\n" + testBearer + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestStreamRedactor(t)
			first := s.Write(tc.text[:strings.IndexByte(tc.text, '\n')+1])
			if first != "" {
				t.Fatalf("dangling line released early: %q", first)
			}
			all, _ := feed(s, tc.text[strings.IndexByte(tc.text, '\n')+1:], 3)
			all = first + all
			assertNoSecret(t, tc.name, all)
			if !strings.Contains(all, "[redacted]") {
				t.Fatalf("not redacted: %q", all)
			}
		})
	}
}

func TestStreamRedactorNeverShowsPrivateKeyBlocks(t *testing.T) {
	block := "-----BEGIN OPENSSH PRIVATE KEY-----\n" + testKey + "\n"
	t.Run("complete", func(t *testing.T) {
		s := newTestStreamRedactor(t)
		shown := s.Write("before\n" + block)
		if shown != "before\n" {
			t.Fatalf("key lines released before END: %q", shown)
		}
		all, _ := feed(s, "-----END OPENSSH PRIVATE KEY----- tail\n", 5)
		assertNoSecret(t, "complete", shown+all)
		if !strings.Contains(all, "tail") {
			t.Fatalf("text after the block lost: %q", all)
		}
	})
	t.Run("unterminated", func(t *testing.T) {
		s := newTestStreamRedactor(t)
		all, before := feed(s, "before\n"+block+testKey+"\n", 4)
		assertNoSecret(t, "unterminated", all)
		if before != "before\n" || !strings.Contains(all, streamRedactedKeyMarker) {
			t.Fatalf("before flush %q, all %q", before, all)
		}
	})
	t.Run("oversized", func(t *testing.T) {
		s := newTestStreamRedactor(t)
		long := block + strings.Repeat(testKey+"\n", streamRedactMaxKeyBytes/len(testKey)+2)
		all, before := feed(s, long+"after the key\n", 1024)
		assertNoSecret(t, "oversized", all)
		if before != streamRedactedKeyMarker+"after the key\n" {
			t.Fatalf("oversized key: %q", before)
		}
	})
	t.Run("oversized then END", func(t *testing.T) {
		s := newTestStreamRedactor(t)
		long := block + strings.Repeat(testKey+"\n", streamRedactMaxKeyBytes/len(testKey)+2)
		// A bare word after an over-long block looks like key material and is dropped too.
		all, _ := feed(s, long+"word\n-----END OPENSSH PRIVATE KEY----- tail\nnext\n", 512)
		assertNoSecret(t, "oversized then END", all)
		if all != streamRedactedKeyMarker+" tail\nnext\n" {
			t.Fatalf("got %q", all)
		}
	})
}

func TestStreamRedactorDropsOverlongLines(t *testing.T) {
	s := newTestStreamRedactor(t)
	long := "token=" + testKV + strings.Repeat("x", streamRedactMaxLineBytes) + " " + testKV + "\n"
	all, _ := feed(s, "before\n"+long+"after\n", 4096)
	assertNoSecret(t, "long line", all)
	if all != "before\n"+streamRedactedLongMarker+"after\n" {
		t.Fatalf("got %q", all)
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
	t.Run("multi line", func(t *testing.T) {
		s := newTestStreamRedactor(t, RegexPattern{Name: "block", Re: `(?s)<secret>.*?</secret>`})
		if got := s.Write("a\n<secret>\n"); got != "" {
			t.Fatalf("held stream released: %q", got)
		}
		s.Write(testKV + "\n")
		all := s.Write("</secret>\nb\n") + s.Flush()
		assertNoSecret(t, "multi line", all)
		if all != "a\n[redacted]\nb\n" {
			t.Fatalf("got %q", all)
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

// Review finding: an unclosed key block whose last line had no newline leaked that line.
func TestStreamRedactorFlushDropsUnfinishedKeyLine(t *testing.T) {
	for _, tc := range []struct{ name, text string }{
		{"body after BEGIN line", "before\n-----BEGIN RSA PRIVATE KEY-----\n" + testKey},
		{"BEGIN without newline", "before\n-----BEGIN RSA PRIVATE KEY-----" + testKey},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestStreamRedactor(t)
			all, _ := feed(s, tc.text, 7)
			assertNoSecret(t, tc.name, all)
			if all != "before\n"+streamRedactedKeyMarker {
				t.Fatalf("got %q", all)
			}
		})
	}
}

// Review finding: a quoted MISTER_MORPH_* value over two lines showed its second line.
func TestStreamRedactorHoldsQuotedEnvValues(t *testing.T) {
	text := "MISTER_MORPH_API_KEY=\"first" + testEnv + "\nsecond" + testKV + "\"\nafter\n"
	want, _ := New(Config{Enabled: true}, nil, nil).RedactString(text)
	for n := 1; n <= len(text); n++ {
		s := newTestStreamRedactor(t)
		all, _ := feed(s, text, n)
		assertNoSecret(t, "chunk size "+itoa(n), all)
		if all != want {
			t.Fatalf("chunk size %d: got %q, want %q", n, all, want)
		}
	}
	s := newTestStreamRedactor(t)
	if got := s.Write("MISTER_MORPH_API_KEY='open\n"); got != "" {
		t.Fatalf("open quote released: %q", got)
	}
	if got := s.Write("still open\n"); got != "" {
		t.Fatalf("open quote released: %q", got)
	}
	// Past the limit the held value is hidden, not released, up to its closing quote.
	got := s.Write(strings.Repeat(testKV+"\n", streamRedactMaxHeldBytes/len(testKV)+1))
	got += s.Write(testKV + "\n" + testKV + "' tail\nnext\n")
	assertNoSecret(t, "open quote over limit", got)
	if got != streamRedactedHeldMarker+" tail\nnext\n" {
		t.Fatalf("over limit = %q", got)
	}
}

func TestStreamRedactorKeepsDanglingContextPastTheLimit(t *testing.T) {
	s := newTestStreamRedactor(t)
	got := s.Write("api_key:\n" + strings.Repeat("\n", streamRedactMaxHeldBytes+1))
	got += s.Write("  " + testKV + "\n")
	assertNoSecret(t, "dangling over limit", got)
	if !strings.HasPrefix(got, streamRedactedHeldMarker) || !strings.Contains(got, "[redacted]") {
		t.Fatalf("got %q", got)
	}
}

// Review finding: releasing at the size limit split an open multi-line custom match.
func TestStreamRedactorHidesHeldTextAtTheLimit(t *testing.T) {
	s := newTestStreamRedactor(t, RegexPattern{Name: "block", Re: `(?s)<secret>.*?</secret>`})
	text := strings.Repeat("safe\n", 13105) + "<secret>\nSENSITIVEPAYLOAD123456\n</secret>\n"
	all, _ := feed(s, text, 4096)
	if strings.Contains(all, "SENSITIVEPAYLOAD") {
		t.Fatalf("payload shown: ...%q", all[max(0, len(all)-200):])
	}
	if !strings.HasSuffix(all, streamRedactedRestMarker) {
		t.Fatalf("no marker for the hidden rest: ...%q", all[max(0, len(all)-200):])
	}
	// Under the limit, the stream is held to its end and redacted whole.
	s = newTestStreamRedactor(t, RegexPattern{Name: "block", Re: `(?s)<secret>.*?</secret>`})
	all, before := feed(s, "safe\n<secret>\nSENSITIVEPAYLOAD123456\n</secret>\nok\n", 3)
	if before != "" || all != "safe\n[redacted]\nok\n" {
		t.Fatalf("before %q, all %q", before, all)
	}
}

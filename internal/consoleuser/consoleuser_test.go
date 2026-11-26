package consoleuser

import (
	"strings"
	"testing"
)

func TestNormalizeName(t *testing.T) {
	eighty := strings.Repeat("名", MaxNameLength)
	emojiEighty := strings.Repeat("🙂", MaxNameLength)
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr string
	}{
		{name: "plain", in: "Lyra", want: "Lyra"},
		{name: "surrounding ascii space", in: "  Lyra \t", want: "Lyra"},
		{name: "surrounding unicode space", in: "\u3000\u00a0\u2003Lyra\u2009\u202f\u205f\u1680\u0085\ufeff", want: "Lyra"},
		{name: "surrounding line breaks", in: "\r\nLyra\n\u2028\u2029", want: "Lyra"},
		{name: "internal spaces", in: " Ada  Lovelace ", want: "Ada  Lovelace"},
		{name: "internal ideographic space", in: "山田\u3000太郎", want: "山田\u3000太郎"},
		{name: "cjk", in: "小明", want: "小明"},
		{name: "emoji with joiners", in: "👩‍💻 Zoë 🇯🇵", want: "👩‍💻 Zoë 🇯🇵"},
		{name: "markup stays text", in: "<b>**Bo**</b> `x` [a](b)", want: "<b>**Bo**</b> `x` [a](b)"},
		{name: "80 code points", in: eighty, want: eighty},
		{name: "80 astral code points", in: emojiEighty, want: emojiEighty},
		{name: "80 code points after trimming", in: " " + eighty + " ", want: eighty},
		{name: "81 code points", in: eighty + "名", wantErr: "at most 80"},
		{name: "81 astral code points", in: emojiEighty + "🙂", wantErr: "at most 80"},
		{name: "empty", in: "", wantErr: "must not be empty"},
		{name: "ascii spaces only", in: "   ", wantErr: "must not be empty"},
		{name: "unicode spaces only", in: "\u3000\u00a0\u2003\u2028\ufeff\t\n", wantErr: "must not be empty"},
		{name: "line feed inside", in: "Ada\nLovelace", wantErr: "one line"},
		{name: "carriage return inside", in: "Ada\rLovelace", wantErr: "one line"},
		{name: "line separator inside", in: "Ada\u2028Lovelace", wantErr: "one line"},
		{name: "paragraph separator inside", in: "Ada\u2029Lovelace", wantErr: "one line"},
		{name: "next line inside", in: "Ada\u0085Lovelace", wantErr: "one line"},
		{name: "tab inside", in: "Ada\tLovelace", wantErr: "control"},
		{name: "nul inside", in: "Ada\x00Lovelace", wantErr: "control"},
		{name: "escape inside", in: "Ada\x1b[31m", wantErr: "control"},
		{name: "delete inside", in: "Ada\x7fLovelace", wantErr: "control"},
		{name: "c1 control inside", in: "Ada\u009bLovelace", wantErr: "control"},
		{name: "invalid utf-8", in: "Ada\xff", wantErr: "valid text"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeName(tc.in)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("NormalizeName(%q) = %q, %v; want an error with %q", tc.in, got, err, tc.wantErr)
				}
				if got != "" {
					t.Fatalf("NormalizeName(%q) = %q with an error, want no value", tc.in, got)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("NormalizeName(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
			}
			if again, err := NormalizeName(got); err != nil || again != got {
				t.Fatalf("NormalizeName(%q) again = %q, %v; want it unchanged", got, again, err)
			}
		})
	}
}

func TestDisplayName(t *testing.T) {
	cases := map[string]string{
		"":             DefaultDisplayName,
		"   ":          DefaultDisplayName,
		"a\nb":         DefaultDisplayName,
		" 小明 🙂 ":       "小明 🙂",
		"Console User": "Console User",
	}
	for in, want := range cases {
		if got := DisplayName(in); got != want {
			t.Errorf("DisplayName(%q) = %q, want %q", in, got, want)
		}
	}
	if DisplayName(strings.Repeat("x", MaxNameLength+1)) != DefaultDisplayName {
		t.Error("an overlong saved name is shown, want the default")
	}
}

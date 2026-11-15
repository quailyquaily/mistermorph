package agent

import (
	"slices"
	"testing"
)

func TestExtractFileWritePaths(t *testing.T) {
	cases := []struct {
		name string
		task string
		want []string
	}{
		{name: "empty", task: "   ", want: nil},
		{name: "no write request", task: "Summarize this repo.", want: nil},
		{
			// The reported run: the old pattern read this as a file named "the de".
			name: "prose before a directory",
			task: "Define the shared popup presentation. Write down to the design/ folder.",
			want: nil,
		},
		{name: "prose article only", task: "write to the folder", want: nil},
		{name: "prose noun", task: "Save it to disk when done", want: nil},
		{name: "directory with trailing slash", task: "write to design/", want: nil},
		{name: "directory then word", task: "Write down to design/ folder", want: nil},
		{name: "directory in backticks", task: "save it to `design/`", want: nil},
		{name: "directory without extension", task: "output to docs/design", want: nil},
		{name: "quoted prose", task: `save it to "the design folder"`, want: nil},
		{name: "windows directory", task: `write to design\`, want: nil},
		{name: "url", task: "output to https://example.com/hook.json", want: nil},
		{name: "abbreviation", task: "write to e.g. the docs folder", want: nil},
		{name: "dot dirs", task: "save it to ./ and write to ..", want: nil},
		{name: "unterminated quote", task: "save it to \"design/mobile popups.md\nthen stop", want: nil},
		{name: "unterminated backtick", task: "write to `design/notes.md", want: nil},
		{name: "empty quotes", task: `write to ""`, want: nil},

		{name: "relative file", task: "Write to design/mobile-popups.md", want: []string{"design/mobile-popups.md"}},
		{name: "write down", task: "write down to design/mobile-popups.md please", want: []string{"design/mobile-popups.md"}},
		{name: "names with s", task: "save it to results/status-summaries.md", want: []string{"results/status-summaries.md"}},
		{name: "s only name", task: "output to sss.css", want: []string{"sss.css"}},
		{name: "whitespace ends an unquoted path", task: "write to notes.md and then stop", want: []string{"notes.md"}},
		{name: "tab ends an unquoted path", task: "write to notes.md\tthen stop", want: []string{"notes.md"}},
		{name: "newline ends an unquoted path", task: "write to notes.md\nthen stop", want: []string{"notes.md"}},
		{name: "sentence punctuation", task: "Save it to out/report.md.", want: []string{"out/report.md"}},
		{name: "parentheses", task: "write to (out/report.md), then stop", want: []string{"out/report.md"}},
		{name: "backticks", task: "write to `design/mobile-popups.md`.", want: []string{"design/mobile-popups.md"}},
		{name: "backticks with spaces", task: "save it to `design/mobile popups.md` now", want: []string{"design/mobile popups.md"}},
		{name: "double quotes with spaces", task: `Output to "My Notes/final report.md".`, want: []string{"My Notes/final report.md"}},
		{name: "single quotes with spaces", task: "write into 'status reports/week s.txt'", want: []string{"status reports/week s.txt"}},
		{name: "absolute path", task: "save to /tmp/out/result.json", want: []string{"/tmp/out/result.json"}},
		{name: "windows path", task: `save to C:\Users\me\notes.txt`, want: []string{`C:\Users\me\notes.txt`}},
		{name: "dotfile", task: "write to .env", want: []string{".env"}},
		{name: "double extension", task: "output to dist/site.tar.gz", want: []string{"dist/site.tar.gz"}},
		{name: "case is kept", task: "Write to Docs/README.md and save it to docs/readme.md", want: []string{"Docs/README.md", "docs/readme.md"}},
		{name: "duplicates", task: "write to a.md. Again: write to a.md", want: []string{"a.md"}},
		{
			name: "file after a directory request",
			task: "Write down to the design/ folder. Then save it to design/index.md",
			want: []string{"design/index.md"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractFileWritePaths(tc.task)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("ExtractFileWritePaths(%q) = %q, want %q", tc.task, got, tc.want)
			}
		})
	}
}

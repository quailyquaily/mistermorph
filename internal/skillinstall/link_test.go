package skillinstall

import "testing"

func TestParseLink(t *testing.T) {
	cases := []struct {
		link string
		want Target
		dir  string
	}{
		{"https://github.com/acme/skills", Target{Kind: "github", Owner: "acme", Repo: "skills"}, ""},
		{"https://github.com/acme/skills.git", Target{Kind: "github", Owner: "acme", Repo: "skills"}, ""},
		{"https://github.com/acme/skills/tree/main/pdf-tools", Target{Kind: "github", Owner: "acme", Repo: "skills", Ref: "main", Path: "pdf-tools"}, "pdf-tools"},
		{"https://github.com/acme/skills/blob/v1/skills/pdf/SKILL.md", Target{Kind: "github", Owner: "acme", Repo: "skills", Ref: "v1", Path: "skills/pdf/SKILL.md"}, "skills/pdf"},
		{"https://github.com/acme/skills/blob/main/SKILL.md", Target{Kind: "github", Owner: "acme", Repo: "skills", Ref: "main", Path: "SKILL.md"}, ""},
		{"https://raw.githubusercontent.com/acme/skills/main/pdf/SKILL.md", Target{Kind: "github", Owner: "acme", Repo: "skills", Ref: "main", Path: "pdf/SKILL.md"}, "pdf"},
		{"https://example.com/skills/pdf/SKILL.md#top", Target{Kind: "url", URL: "https://example.com/skills/pdf/SKILL.md"}, ""},
	}
	for _, tc := range cases {
		got, err := ParseLink(tc.link)
		if err != nil {
			t.Fatalf("ParseLink(%q) error = %v", tc.link, err)
		}
		if got != tc.want {
			t.Fatalf("ParseLink(%q) = %+v, want %+v", tc.link, got, tc.want)
		}
		if got.Kind == "github" && got.skillDir() != tc.dir {
			t.Fatalf("skillDir(%q) = %q, want %q", tc.link, got.skillDir(), tc.dir)
		}
	}
	for _, bad := range []string{"", "not a link", "http://github.com/acme/skills", "https://github.com/acme", "https://github.com/acme/skills/issues/1", "https://example.com/readme.md", "ftp://x/SKILL.md"} {
		if _, err := ParseLink(bad); err == nil {
			t.Fatalf("ParseLink(%q) succeeded", bad)
		}
	}
}

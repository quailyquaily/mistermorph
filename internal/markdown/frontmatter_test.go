package markdown

import "testing"

type sampleFrontmatter struct {
	Status string   `yaml:"status"`
	Tags   []string `yaml:"tags"`
}

func TestSplitFrontmatter(t *testing.T) {
	in := "---\nstatus: active\n---\n\n# Title\nBody\n"
	raw, body, ok := SplitFrontmatter(in)
	if !ok {
		t.Fatalf("expected frontmatter to be found")
	}
	if raw != "status: active" {
		t.Fatalf("unexpected raw frontmatter: %q", raw)
	}
	if body != "\n# Title\nBody\n" {
		t.Fatalf("unexpected body: %q", body)
	}
}

func TestStripFrontmatter(t *testing.T) {
	in := "---\nstatus: active\n---\n# Title\n"
	got := StripFrontmatter(in)
	if got != "# Title\n" {
		t.Fatalf("StripFrontmatter mismatch: %q", got)
	}
}

func TestParseFrontmatter(t *testing.T) {
	in := "---\nstatus: active\ntags:\n  - a\n  - b\n---\nText\n"
	fm, body, ok := ParseFrontmatter[sampleFrontmatter](in)
	if !ok {
		t.Fatalf("expected ParseFrontmatter ok=true")
	}
	if fm.Status != "active" {
		t.Fatalf("unexpected status: %q", fm.Status)
	}
	if len(fm.Tags) != 2 || fm.Tags[0] != "a" || fm.Tags[1] != "b" {
		t.Fatalf("unexpected tags: %#v", fm.Tags)
	}
	if body != "Text\n" {
		t.Fatalf("unexpected body: %q", body)
	}
}

func TestParseFrontmatterInvalidYAML(t *testing.T) {
	in := "---\nstatus: [\n---\nText\n"
	_, body, ok := ParseFrontmatter[sampleFrontmatter](in)
	if ok {
		t.Fatalf("expected ParseFrontmatter ok=false for invalid yaml")
	}
	if body != "Text\n" {
		t.Fatalf("expected body fallback even on invalid yaml: %q", body)
	}
}

func TestFrontmatterStatus(t *testing.T) {
	in := "---\nstatus: draft\n---\nText\n"
	if got := FrontmatterStatus(in); got != "draft" {
		t.Fatalf("FrontmatterStatus mismatch: %q", got)
	}
}

func TestFrontmatterStatusFallbackOnInvalidYAML(t *testing.T) {
	in := "---\nstatus: draft\nbad: [\n---\nText\n"
	if got := FrontmatterStatus(in); got != "draft" {
		t.Fatalf("FrontmatterStatus fallback mismatch: %q", got)
	}
}

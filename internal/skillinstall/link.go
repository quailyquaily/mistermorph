// Package skillinstall previews and installs skills from links and from the skill store.
//
// A preview downloads a skill into a staging directory, pins it (a GitHub commit and per-file
// SHA-256 checksums), and reviews it. An install only ever moves the files of an existing
// preview into the skills root, after checking their checksums again, so what is installed is
// byte-for-byte what was reviewed and approved.
package skillinstall

import (
	"fmt"
	"net/url"
	"path"
	"strings"
)

// Target is a parsed install link.
type Target struct {
	Kind string // "github" or "url"
	// GitHub links.
	Owner string
	Repo  string
	Ref   string // branch, tag or commit; empty means the default branch
	Path  string // directory (or SKILL.md file) inside the repo; empty means the repo root
	// Plain links: a SKILL.md served over https.
	URL string
}

// ParseLink accepts GitHub repo, tree, blob and raw links, and plain https links to a SKILL.md.
func ParseLink(raw string) (Target, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return Target{}, fmt.Errorf("not a link: %q", raw)
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return Target{}, fmt.Errorf("only https links can be installed")
	}
	host := strings.ToLower(u.Hostname())
	parts := splitPath(u.Path)
	switch host {
	case "github.com", "www.github.com":
		if len(parts) < 2 {
			return Target{}, fmt.Errorf("a GitHub link needs an owner and a repository")
		}
		t := Target{Kind: "github", Owner: parts[0], Repo: strings.TrimSuffix(parts[1], ".git")}
		if len(parts) == 2 {
			return t, nil
		}
		if len(parts) < 4 || (parts[2] != "tree" && parts[2] != "blob") {
			return Target{}, fmt.Errorf("unsupported GitHub link; use the repository, a folder (tree) or a SKILL.md (blob) link")
		}
		t.Ref = parts[3]
		t.Path = strings.Join(parts[4:], "/")
		return t, nil
	case "raw.githubusercontent.com":
		if len(parts) < 4 {
			return Target{}, fmt.Errorf("unsupported raw GitHub link")
		}
		return Target{Kind: "github", Owner: parts[0], Repo: parts[1], Ref: parts[2], Path: strings.Join(parts[3:], "/")}, nil
	}
	if !strings.EqualFold(path.Base(u.Path), "SKILL.md") {
		return Target{}, fmt.Errorf("links outside GitHub must point at a SKILL.md file")
	}
	u.Fragment = ""
	return Target{Kind: "url", URL: u.String()}, nil
}

// skillDir is the directory a GitHub link names: the link's folder, or the folder holding the
// SKILL.md it names.
func (t Target) skillDir() string {
	p := strings.Trim(t.Path, "/")
	if strings.EqualFold(path.Base(p), "SKILL.md") {
		p = path.Dir(p)
		if p == "." {
			p = ""
		}
	}
	return p
}

func splitPath(p string) []string {
	var out []string
	for _, part := range strings.Split(p, "/") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

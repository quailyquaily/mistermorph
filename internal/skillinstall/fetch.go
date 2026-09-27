package skillinstall

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	MaxFileBytes  = 512 * 1024
	MaxSkillFiles = 50
	// DefaultMaxSkillBytes caps a whole skill unless Options.MaxSkillBytes
	// (tools.skill_install.max_bytes) sets another limit.
	DefaultMaxSkillBytes = 16 * 1024 * 1024
)

const (
	defaultGitHubAPI = "https://api.github.com"
	defaultGitHubRaw = "https://raw.githubusercontent.com"
)

// File is one downloaded skill file.
type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	data   []byte
}

// fetched is a skill downloaded and pinned, not yet staged.
type fetched struct {
	source Source
	files  []File
}

// Source records where a skill came from.
type Source struct {
	Kind    string `json:"kind"` // "github", "url" or "store"
	URL     string `json:"url"`
	Repo    string `json:"repo,omitempty"` // owner/name
	Path    string `json:"path,omitempty"` // skill folder in the repo
	Commit  string `json:"commit,omitempty"`
	StoreID string `json:"store_id,omitempty"`
	Version string `json:"version,omitempty"`
}

type fetcher struct {
	http      *http.Client
	githubAPI string
	githubRaw string
	// maxSkillBytes caps the whole skill; 0 means DefaultMaxSkillBytes.
	maxSkillBytes int64
}

func (f fetcher) skillByteLimit() int64 {
	if f.maxSkillBytes > 0 {
		return f.maxSkillBytes
	}
	return DefaultMaxSkillBytes
}

func (f fetcher) client() *http.Client {
	if f.http != nil {
		return f.http
	}
	return http.DefaultClient
}

func (f fetcher) apiBase() string {
	if f.githubAPI != "" {
		return strings.TrimRight(f.githubAPI, "/")
	}
	return defaultGitHubAPI
}

func (f fetcher) rawBase() string {
	if f.githubRaw != "" {
		return strings.TrimRight(f.githubRaw, "/")
	}
	return defaultGitHubRaw
}

// errCandidates lists the skills a repository link could mean, so the caller can ask which one.
type errCandidates struct {
	Repo  string
	Paths []string
}

func (e errCandidates) Error() string {
	return fmt.Sprintf("%s holds several skills (%s); link the one to install", e.Repo, strings.Join(e.Paths, ", "))
}

func (f fetcher) fetch(ctx context.Context, target Target) (fetched, error) {
	switch target.Kind {
	case "github":
		return f.fetchGitHub(ctx, target)
	case "url":
		data, err := f.get(ctx, target.URL, MaxFileBytes)
		if err != nil {
			return fetched{}, err
		}
		file, err := newFile("SKILL.md", data)
		if err != nil {
			return fetched{}, err
		}
		return fetched{source: Source{Kind: "url", URL: target.URL}, files: []File{file}}, nil
	}
	return fetched{}, fmt.Errorf("unsupported link kind %q", target.Kind)
}

type githubTreeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}

func (f fetcher) fetchGitHub(ctx context.Context, target Target) (fetched, error) {
	repo := target.Owner + "/" + target.Repo
	ref := target.Ref
	if ref == "" {
		var info struct {
			DefaultBranch string `json:"default_branch"`
		}
		if err := f.getJSON(ctx, fmt.Sprintf("%s/repos/%s", f.apiBase(), repo), &info); err != nil {
			return fetched{}, err
		}
		ref = info.DefaultBranch
	}
	var commit struct {
		SHA string `json:"sha"`
	}
	if err := f.getJSON(ctx, fmt.Sprintf("%s/repos/%s/commits/%s", f.apiBase(), repo, url.PathEscape(ref)), &commit); err != nil {
		return fetched{}, fmt.Errorf("resolve %s@%s: %w", repo, ref, err)
	}
	if !isCommitSHA(commit.SHA) {
		return fetched{}, fmt.Errorf("resolve %s@%s: no commit", repo, ref)
	}
	var tree struct {
		Tree      []githubTreeEntry `json:"tree"`
		Truncated bool              `json:"truncated"`
	}
	if err := f.getJSON(ctx, fmt.Sprintf("%s/repos/%s/git/trees/%s?recursive=1", f.apiBase(), repo, commit.SHA), &tree); err != nil {
		return fetched{}, err
	}

	dir := target.skillDir()
	if target.Path == "" {
		picked, err := pickRepoSkill(repo, tree.Tree)
		if err != nil {
			return fetched{}, err
		}
		dir = picked
	}
	prefix := ""
	if dir != "" {
		prefix = dir + "/"
	}
	var entries []githubTreeEntry
	hasSkillMD := false
	for _, entry := range tree.Tree {
		if !strings.HasPrefix(entry.Path, prefix) || entry.Type != "blob" {
			continue
		}
		rel := strings.TrimPrefix(entry.Path, prefix)
		if entry.Mode == "120000" {
			return fetched{}, fmt.Errorf("%s is a symlink; skills cannot contain symlinks", rel)
		}
		if rel == "SKILL.md" {
			hasSkillMD = true
		}
		entries = append(entries, entry)
	}
	if !hasSkillMD {
		return fetched{}, fmt.Errorf("no SKILL.md in %s/%s", repo, dir)
	}
	if len(entries) > MaxSkillFiles {
		return fetched{}, fmt.Errorf("the skill has %d files; the limit is %d", len(entries), MaxSkillFiles)
	}
	var total int64
	for _, entry := range entries {
		total += entry.Size
	}
	if limit := f.skillByteLimit(); total > limit {
		return fetched{}, fmt.Errorf("the skill is %d bytes; the limit is %d (tools.skill_install.max_bytes)", total, limit)
	}

	out := fetched{source: Source{
		Kind:   "github",
		URL:    githubTreeURL(repo, commit.SHA, dir),
		Repo:   repo,
		Path:   dir,
		Commit: commit.SHA,
	}}
	for _, entry := range entries {
		rel := strings.TrimPrefix(entry.Path, prefix)
		data, err := f.get(ctx, fmt.Sprintf("%s/%s/%s/%s", f.rawBase(), repo, commit.SHA, escapePath(entry.Path)), MaxFileBytes)
		if err != nil {
			return fetched{}, err
		}
		file, err := newFile(rel, data)
		if err != nil {
			return fetched{}, err
		}
		out.files = append(out.files, file)
	}
	sortFiles(out.files)
	return out, nil
}

// pickRepoSkill finds the skill in a repository link: SKILL.md at the root, or the only
// <dir>/SKILL.md or skills/<dir>/SKILL.md.
func pickRepoSkill(repo string, tree []githubTreeEntry) (string, error) {
	var candidates []string
	for _, entry := range tree {
		if entry.Type != "blob" || path.Base(entry.Path) != "SKILL.md" {
			continue
		}
		dir := path.Dir(entry.Path)
		if dir == "." {
			return "", nil
		}
		depth := strings.Count(dir, "/") + 1
		if depth == 1 || (depth == 2 && strings.HasPrefix(dir, "skills/")) {
			candidates = append(candidates, dir)
		}
	}
	sort.Strings(candidates)
	switch len(candidates) {
	case 0:
		return "", fmt.Errorf("no SKILL.md found in %s", repo)
	case 1:
		return candidates[0], nil
	}
	return "", errCandidates{Repo: repo, Paths: candidates}
}

// newFile checks one file: a safe relative path, within the size limit, and text.
func newFile(rel string, data []byte) (File, error) {
	clean := path.Clean(strings.TrimPrefix(rel, "/"))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(rel) {
		return File{}, fmt.Errorf("unsafe path %q", rel)
	}
	if int64(len(data)) > MaxFileBytes {
		return File{}, fmt.Errorf("%s is larger than %d bytes", clean, MaxFileBytes)
	}
	if !isText(data) {
		return File{}, fmt.Errorf("%s is not a text file; skills can only contain text", clean)
	}
	sum := sha256.Sum256(data)
	return File{Path: clean, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), data: data}, nil
}

func isText(data []byte) bool {
	return utf8.Valid(data) && !bytes.Contains(data, []byte{0})
}

func (f fetcher) getJSON(ctx context.Context, rawURL string, out any) error {
	data, err := f.get(ctx, rawURL, 8*1024*1024)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func (f fetcher) get(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "mistermorph-skill-install")
	if strings.HasPrefix(rawURL, f.apiBase()) {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	resp, err := f.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", rawURL, resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("GET %s: larger than %d bytes", rawURL, limit)
	}
	return data, nil
}

func githubTreeURL(repo, commit, dir string) string {
	if dir == "" {
		return fmt.Sprintf("https://github.com/%s/tree/%s", repo, commit)
	}
	return fmt.Sprintf("https://github.com/%s/tree/%s/%s", repo, commit, dir)
}

func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

func isCommitSHA(s string) bool {
	if len(s) != 40 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func sortFiles(files []File) {
	sort.Slice(files, func(i, j int) bool {
		if (files[i].Path == "SKILL.md") != (files[j].Path == "SKILL.md") {
			return files[i].Path == "SKILL.md"
		}
		return files[i].Path < files[j].Path
	})
}

var errPreviewNotFound = errors.New("preview not found or expired; preview the skill again")

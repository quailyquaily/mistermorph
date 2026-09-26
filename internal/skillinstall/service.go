package skillinstall

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/skills"
)

const defaultPreviewTTL = 30 * time.Minute

// Review is an isolated model's reading of a skill. The skill text is untrusted, so the review
// is advisory: it never decides what gets installed.
type Review struct {
	Summary      string   `json:"summary"`
	Capabilities []string `json:"capabilities,omitempty"`
	Risks        []string `json:"risks,omitempty"`
}

// ReviewInput is what the reviewer sees.
type ReviewInput struct {
	Source  Source
	SkillMD string
	Files   []string
}

type ReviewFunc func(context.Context, ReviewInput) (Review, error)

// Options configure a preview or an install. SkillsRoot and StagingDir are required.
type Options struct {
	SkillsRoot string
	StagingDir string
	HTTPClient *http.Client
	GitHubAPI  string
	GitHubRaw  string
	Review     ReviewFunc
	// Enable switches an installed skill on (skills.enabled / skills.load).
	Enable func(ctx context.Context, skillID string) error
}

// Expectation pins a preview to known content, e.g. a store entry: the fetched source must be at
// Commit and the files must match Files (path -> sha256) exactly.
type Expectation struct {
	Source Source
	Files  map[string]string
}

// Preview is what the user approves.
type Preview struct {
	ID           string    `json:"preview_id"`
	SkillID      string    `json:"skill_id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Source       Source    `json:"source"`
	Files        []File    `json:"files"`
	TotalBytes   int64     `json:"total_bytes"`
	Requirements []string  `json:"requirements,omitempty"`
	AuthProfiles []string  `json:"auth_profiles,omitempty"`
	Risks        []string  `json:"risks,omitempty"`
	Review       *Review   `json:"review,omitempty"`
	ReviewError  string    `json:"review_error,omitempty"`
	Conflict     *Conflict `json:"conflict,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// Conflict reports a skill already installed under the same id.
type Conflict struct {
	Dir    string  `json:"dir"`
	Source *Source `json:"source,omitempty"`
}

// Installed is the result of an install.
type Installed struct {
	SkillID  string `json:"skill_id"`
	Name     string `json:"name"`
	Dir      string `json:"dir"`
	Source   Source `json:"source"`
	Replaced bool   `json:"replaced,omitempty"`
}

// InstallRequest must repeat the preview's name, source and commit; the approval card shows
// these, so an install cannot differ from what the user approved.
type InstallRequest struct {
	PreviewID string
	Name      string
	SourceURL string
	Commit    string
	Replace   bool
}

type stagedPreview struct {
	preview Preview
	dir     string
}

// Service keeps previews between the preview and the install call. One per process.
type Service struct {
	mu       sync.Mutex
	previews map[string]*stagedPreview
	now      func() time.Time
	ttl      time.Duration
}

func NewService() *Service {
	return &Service{previews: map[string]*stagedPreview{}, now: time.Now, ttl: defaultPreviewTTL}
}

// Preview downloads a skill into staging, pins and reviews it. expect may be nil.
func (s *Service) Preview(ctx context.Context, opts Options, link string, expect *Expectation) (Preview, error) {
	if strings.TrimSpace(opts.SkillsRoot) == "" || strings.TrimSpace(opts.StagingDir) == "" {
		return Preview{}, errors.New("skill install is not configured")
	}
	target, err := ParseLink(link)
	if err != nil {
		return Preview{}, err
	}
	got, err := fetcher{http: opts.HTTPClient, githubAPI: opts.GitHubAPI, githubRaw: opts.GitHubRaw}.fetch(ctx, target)
	if err != nil {
		return Preview{}, err
	}
	if expect != nil {
		if err := checkExpectation(got, *expect); err != nil {
			return Preview{}, err
		}
		got.source.Kind = "store"
		got.source.StoreID = expect.Source.StoreID
		got.source.Version = expect.Source.Version
	}

	skillMD := string(got.files[0].data)
	fm, _ := skills.ParseFrontmatter(skillMD)
	skillID, err := skillIDFor(fm.Name, got.source)
	if err != nil {
		return Preview{}, err
	}
	preview := Preview{
		ID:           newPreviewID(),
		SkillID:      skillID,
		Name:         firstNonEmpty(fm.Name, skillID),
		Description:  truncate(fm.Description, 400),
		Source:       got.source,
		Requirements: fm.Requirements,
		AuthProfiles: fm.AuthProfiles,
		Risks:        scanRisks(got.files),
		ExpiresAt:    s.now().Add(s.ttl),
	}
	for _, file := range got.files {
		preview.Files = append(preview.Files, File{Path: file.Path, Size: file.Size, SHA256: file.SHA256})
		preview.TotalBytes += file.Size
	}
	if existing := filepath.Join(opts.SkillsRoot, skillID); dirExists(existing) {
		conflict := &Conflict{Dir: existing}
		if p, ok := ReadProvenance(existing); ok {
			src := p.Source
			conflict.Source = &src
		}
		preview.Conflict = conflict
	}
	if opts.Review != nil {
		paths := make([]string, 0, len(preview.Files))
		for _, file := range preview.Files {
			paths = append(paths, file.Path)
		}
		review, err := opts.Review(ctx, ReviewInput{Source: got.source, SkillMD: skillMD, Files: paths})
		if err != nil {
			preview.ReviewError = err.Error()
		} else {
			preview.Review = &review
		}
	}

	dir := filepath.Join(opts.StagingDir, preview.ID)
	if err := stageFiles(dir, got.files); err != nil {
		_ = os.RemoveAll(dir)
		return Preview{}, err
	}
	s.mu.Lock()
	s.dropExpiredLocked()
	s.previews[preview.ID] = &stagedPreview{preview: preview, dir: dir}
	s.mu.Unlock()
	return preview, nil
}

// Install moves a preview's files into the skills root after checking them again.
func (s *Service) Install(ctx context.Context, opts Options, req InstallRequest) (Installed, error) {
	s.mu.Lock()
	s.dropExpiredLocked()
	staged, ok := s.previews[strings.TrimSpace(req.PreviewID)]
	if ok {
		delete(s.previews, staged.preview.ID)
	}
	s.mu.Unlock()
	if !ok {
		return Installed{}, errPreviewNotFound
	}
	defer os.RemoveAll(staged.dir)
	p := staged.preview
	if req.Name != p.Name || req.SourceURL != p.Source.URL || req.Commit != p.Source.Commit {
		return Installed{}, errors.New("the install does not match the preview (name, source or commit differ); preview the skill again")
	}
	for _, file := range p.Files {
		data, err := os.ReadFile(filepath.Join(staged.dir, filepath.FromSlash(file.Path)))
		if err != nil {
			return Installed{}, fmt.Errorf("staged %s: %w", file.Path, err)
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != file.SHA256 {
			return Installed{}, fmt.Errorf("staged %s changed since the preview; nothing was installed", file.Path)
		}
	}
	if err := os.MkdirAll(opts.SkillsRoot, 0o755); err != nil {
		return Installed{}, err
	}
	target := filepath.Join(opts.SkillsRoot, p.SkillID)
	backup := ""
	if dirExists(target) {
		if !req.Replace {
			return Installed{}, fmt.Errorf("a skill named %s is already installed; install with replace to overwrite it", p.SkillID)
		}
		backup = fmt.Sprintf("%s.bak-%d", target, s.now().UnixNano())
		if err := os.Rename(target, backup); err != nil {
			return Installed{}, err
		}
	}
	restore := func() {
		_ = os.RemoveAll(target)
		if backup != "" {
			_ = os.Rename(backup, target)
		}
	}
	if err := moveDir(staged.dir, target); err != nil {
		restore()
		return Installed{}, err
	}
	files := make(map[string]string, len(p.Files))
	for _, file := range p.Files {
		files[file.Path] = file.SHA256
	}
	if err := writeProvenance(target, Provenance{Source: p.Source, InstalledAt: s.now().UTC(), Files: files}); err != nil {
		restore()
		return Installed{}, err
	}
	if backup != "" {
		_ = os.RemoveAll(backup)
	}
	if opts.Enable != nil {
		if err := opts.Enable(ctx, p.SkillID); err != nil {
			return Installed{}, fmt.Errorf("installed %s but could not switch it on: %w", p.SkillID, err)
		}
	}
	return Installed{SkillID: p.SkillID, Name: p.Name, Dir: target, Source: p.Source, Replaced: backup != ""}, nil
}

func (s *Service) dropExpiredLocked() {
	now := s.now()
	for id, staged := range s.previews {
		if now.After(staged.preview.ExpiresAt) {
			_ = os.RemoveAll(staged.dir)
			delete(s.previews, id)
		}
	}
}

func checkExpectation(got fetched, expect Expectation) error {
	if expect.Source.Commit != "" && got.source.Commit != expect.Source.Commit {
		return fmt.Errorf("the source is at %s, not the expected commit %s", got.source.Commit, expect.Source.Commit)
	}
	if len(expect.Files) != len(got.files) {
		return fmt.Errorf("the skill has %d files, but %d were expected", len(got.files), len(expect.Files))
	}
	for _, file := range got.files {
		want, ok := expect.Files[file.Path]
		if !ok {
			return fmt.Errorf("unexpected file %s", file.Path)
		}
		if want != file.SHA256 {
			return fmt.Errorf("%s does not match its published checksum", file.Path)
		}
	}
	return nil
}

var skillIDPattern = regexp.MustCompile(`[^a-z0-9._-]+`)

// skillIDFor turns the frontmatter name (or the source folder) into a folder name.
func skillIDFor(name string, source Source) (string, error) {
	for _, candidate := range []string{name, path.Base(source.Path), path.Base(source.Repo)} {
		id := strings.Trim(skillIDPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(candidate)), "-"), "-.")
		if id != "" && id != "." && id != "skills" {
			return id, nil
		}
	}
	return "", errors.New("could not work out a folder name for this skill; give it a name in its frontmatter")
}

func stageFiles(dir string, files []File) error {
	for _, file := range files {
		dest := filepath.Join(dir, filepath.FromSlash(file.Path))
		rel, err := filepath.Rel(dir, dest)
		if err != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("unsafe path %q", file.Path)
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, file.data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// moveDir renames src to dst, copying when they sit on different filesystems.
func moveDir(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
		return err
	}
	return os.RemoveAll(src)
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func newPreviewID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return "skp_" + hex.EncodeToString(b[:])
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

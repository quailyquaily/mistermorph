package skillinstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// DefaultStoreIndexURL is the Morph Skill Store's index, built by the store repository's CI.
const DefaultStoreIndexURL = "https://raw.githubusercontent.com/quailyquaily/morph-skill-store/main/index.json"

const storeCacheTTL = 10 * time.Minute

// StoreIndex is the store's index.json.
type StoreIndex struct {
	Version     int          `json:"version"`
	Repo        string       `json:"repo"`
	GeneratedAt string       `json:"generated_at"`
	Skills      []StoreSkill `json:"skills"`
}

// StoreSkill is one published skill, pinned to a commit with per-file checksums.
type StoreSkill struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Version      string            `json:"version"`
	Description  string            `json:"description"`
	Author       string            `json:"author,omitempty"`
	License      string            `json:"license,omitempty"`
	Homepage     string            `json:"homepage,omitempty"`
	Tags         []string          `json:"tags,omitempty"`
	Requirements []string          `json:"requirements,omitempty"`
	AuthProfiles []string          `json:"auth_profiles,omitempty"`
	Path         string            `json:"path"`
	Commit       string            `json:"commit"`
	Files        map[string]string `json:"files"`
	TotalBytes   int64             `json:"total_bytes,omitempty"`
}

var (
	storeRepoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	storeIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
)

// Link is the pinned GitHub folder link a store install previews.
func (s StoreSkill) Link(repo string) string {
	return githubTreeURL(repo, s.Commit, strings.Trim(s.Path, "/"))
}

// Expectation pins a store install to the index's commit and checksums.
func (s StoreSkill) Expectation() *Expectation {
	files := make(map[string]string, len(s.Files))
	for p, sum := range s.Files {
		files[p] = strings.ToLower(sum)
	}
	return &Expectation{Source: Source{Commit: s.Commit, StoreID: s.ID, Version: s.Version}, Files: files}
}

// Find returns the entry with the given id.
func (idx StoreIndex) Find(id string) (StoreSkill, bool) {
	for _, skill := range idx.Skills {
		if strings.EqualFold(skill.ID, strings.TrimSpace(id)) {
			return skill, true
		}
	}
	return StoreSkill{}, false
}

// validate drops entries that could not be installed safely and checks the index shape.
func (idx *StoreIndex) validate() error {
	if !storeRepoPattern.MatchString(idx.Repo) {
		return fmt.Errorf("store index has an invalid repo %q", idx.Repo)
	}
	valid := idx.Skills[:0]
	for _, skill := range idx.Skills {
		if !storeIDPattern.MatchString(skill.ID) || !isCommitSHA(skill.Commit) || len(skill.Files) == 0 || len(skill.Files) > MaxSkillFiles {
			continue
		}
		if _, ok := skill.Files["SKILL.md"]; !ok {
			continue
		}
		if strings.Contains(skill.Path, "..") {
			continue
		}
		valid = append(valid, skill)
	}
	idx.Skills = valid
	sort.Slice(idx.Skills, func(i, j int) bool { return strings.ToLower(idx.Skills[i].Name) < strings.ToLower(idx.Skills[j].Name) })
	return nil
}

// Store fetches and caches a store index.
type Store struct {
	mu     sync.Mutex
	cached map[string]cachedIndex
	now    func() time.Time
	http   *http.Client
}

type cachedIndex struct {
	index StoreIndex
	at    time.Time
}

func NewStore(client *http.Client) *Store {
	return &Store{cached: map[string]cachedIndex{}, now: time.Now, http: client}
}

// ErrStoreUnavailable wraps failures to reach or read the store.
var ErrStoreUnavailable = errors.New("the skill store is unavailable")

// Index returns the index at url, from cache when fresh.
func (s *Store) Index(ctx context.Context, url string) (StoreIndex, time.Time, error) {
	url = strings.TrimSpace(url)
	if url == "" {
		url = DefaultStoreIndexURL
	}
	s.mu.Lock()
	if hit, ok := s.cached[url]; ok && s.now().Sub(hit.at) < storeCacheTTL {
		s.mu.Unlock()
		return hit.index, hit.at, nil
	}
	s.mu.Unlock()

	data, err := fetcher{http: s.http}.get(ctx, url, 4*1024*1024)
	if err != nil {
		return StoreIndex{}, time.Time{}, fmt.Errorf("%w: %v", ErrStoreUnavailable, err)
	}
	var index StoreIndex
	if err := json.Unmarshal(data, &index); err != nil {
		return StoreIndex{}, time.Time{}, fmt.Errorf("%w: invalid index: %v", ErrStoreUnavailable, err)
	}
	if err := index.validate(); err != nil {
		return StoreIndex{}, time.Time{}, fmt.Errorf("%w: %v", ErrStoreUnavailable, err)
	}
	at := s.now()
	s.mu.Lock()
	s.cached[url] = cachedIndex{index: index, at: at}
	s.mu.Unlock()
	return index, at, nil
}

var (
	defaultStoreOnce sync.Once
	defaultStore     *Store
)

// DefaultStore is the process-wide store client, so the page and the tools share its cache.
func DefaultStore() *Store {
	defaultStoreOnce.Do(func() { defaultStore = NewStore(nil) })
	return defaultStore
}

var (
	defaultServiceOnce sync.Once
	defaultService     *Service
)

// DefaultService is the process-wide preview holder shared by the install tools.
func DefaultService() *Service {
	defaultServiceOnce.Do(func() { defaultService = NewService() })
	return defaultService
}

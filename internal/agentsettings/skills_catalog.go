package agentsettings

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/skillsutil"
	"github.com/quailyquaily/mistermorph/skills"
)

const (
	// Skill files listed per skill; a skill folder is small, so this only bounds odd cases.
	maxSkillCatalogFiles = 200
	// SKILL.md bytes returned by the detail route.
	maxSkillDetailBytes = 256 * 1024
)

// SkillCatalog is the Skills page's view of an agent's skills: every discovered skill with
// the details the page shows, and whether each one is loaded.
type SkillCatalog struct {
	Enabled        bool     `json:"enabled"`
	Load           []string `json:"load"`
	Roots          []string `json:"roots"`
	ReadOnly       bool     `json:"read_only"`
	ReadOnlyReason string   `json:"read_only_reason,omitempty"`
	// ConfigRevision lets the page save switches through the settings update without
	// overwriting a newer config.
	ConfigRevision string              `json:"config_revision"`
	Skills         []SkillCatalogEntry `json:"skills"`
}

type SkillCatalogEntry struct {
	ID           string             `json:"id"`
	Name         string             `json:"name"`
	Description  string             `json:"description"`
	Dir          string             `json:"dir"`
	SkillMD      string             `json:"skill_md"`
	Loaded       bool               `json:"loaded"`
	Requirements []string           `json:"requirements,omitempty"`
	AuthProfiles []string           `json:"auth_profiles,omitempty"`
	Files        []SkillCatalogFile `json:"files"`
	FilesCapped  bool               `json:"files_capped,omitempty"`
}

type SkillCatalogFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// SkillDetail adds the SKILL.md text to a catalog entry.
type SkillDetail struct {
	SkillCatalogEntry
	Content          string `json:"content"`
	ContentTruncated bool   `json:"content_truncated,omitempty"`
}

var errSkillNotFound = errors.New("skill not found")

// BuildSkillCatalog lists the skills under roots. Loaded state comes from the settings view,
// so the page and the agent agree on what is loaded.
func BuildSkillCatalog(settings SkillsSettingsPayload, roots []string) (SkillCatalog, error) {
	catalog := SkillCatalog{
		Enabled: settings.Enabled,
		Load:    append([]string{}, settings.Load...),
		Roots:   append([]string{}, roots...),
		Skills:  []SkillCatalogEntry{},
	}
	discovered, err := discoverSkillsWithFrontmatter(roots)
	if err != nil {
		return catalog, err
	}
	loaded := make(map[string]bool, len(settings.Loaded))
	for _, item := range settings.Loaded {
		loaded[strings.ToLower(strings.TrimSpace(item.ID))] = true
	}
	for _, skill := range discovered {
		entry := catalogEntry(skill)
		entry.Loaded = loaded[strings.ToLower(entry.ID)]
		catalog.Skills = append(catalog.Skills, entry)
	}
	sort.SliceStable(catalog.Skills, func(i, j int) bool {
		return strings.ToLower(catalog.Skills[i].Name) < strings.ToLower(catalog.Skills[j].Name)
	})
	return catalog, nil
}

// ReadSkillDetail finds a discovered skill by id and reads its SKILL.md. Only discovered skills
// are readable, so an id can never point outside the skills roots.
func ReadSkillDetail(settings SkillsSettingsPayload, roots []string, id string) (SkillDetail, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return SkillDetail{}, errSkillNotFound
	}
	catalog, err := BuildSkillCatalog(settings, roots)
	if err != nil {
		return SkillDetail{}, err
	}
	for _, entry := range catalog.Skills {
		if !strings.EqualFold(entry.ID, id) {
			continue
		}
		data, err := os.ReadFile(entry.SkillMD)
		if err != nil {
			return SkillDetail{}, err
		}
		detail := SkillDetail{SkillCatalogEntry: entry}
		if len(data) > maxSkillDetailBytes {
			data = data[:maxSkillDetailBytes]
			for len(data) > 0 && !utf8.Valid(data) {
				data = data[:len(data)-1]
			}
			detail.ContentTruncated = true
		}
		detail.Content = string(data)
		return detail, nil
	}
	return SkillDetail{}, errSkillNotFound
}

func discoverSkillsWithFrontmatter(roots []string) ([]skills.Skill, error) {
	discovered, err := skills.Discover(skills.DiscoverOptions{Roots: roots})
	if err != nil {
		return nil, err
	}
	for i, skill := range discovered {
		withMeta, err := skills.LoadFrontmatter(skill, 64*1024)
		if err != nil {
			continue
		}
		discovered[i] = withMeta
	}
	return discovered, nil
}

func catalogEntry(skill skills.Skill) SkillCatalogEntry {
	name := strings.TrimSpace(skill.Name)
	if name == "" {
		name = strings.TrimSpace(skill.ID)
	}
	files, capped := listSkillFiles(skill.Dir)
	return SkillCatalogEntry{
		ID:           strings.TrimSpace(skill.ID),
		Name:         name,
		Description:  strings.TrimSpace(skill.Description),
		Dir:          skill.Dir,
		SkillMD:      skill.SkillMD,
		Requirements: append([]string(nil), skill.Requirements...),
		AuthProfiles: append([]string(nil), skill.AuthProfiles...),
		Files:        files,
		FilesCapped:  capped,
	}
}

// listSkillFiles lists regular files under a skill folder (a linked folder is followed once),
// skipping dot-directories such as .git.
func listSkillFiles(dir string) ([]SkillCatalogFile, bool) {
	files := []SkillCatalogFile{}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return files, false
	}
	capped := false
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if len(files) >= maxSkillCatalogFiles {
			capped = true
			return filepath.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		files = append(files, SkillCatalogFile{Path: filepath.ToSlash(rel), Size: info.Size()})
		return nil
	})
	sort.Slice(files, func(i, j int) bool {
		// SKILL.md first, then by path.
		if (files[i].Path == "SKILL.md") != (files[j].Path == "SKILL.md") {
			return files[i].Path == "SKILL.md"
		}
		return files[i].Path < files[j].Path
	})
	return files, capped
}

// Skills serves GET /settings/agent/skills.
func (h *Handler) Skills(w http.ResponseWriter, r *http.Request) {
	view, roots, ok := h.skillsContext(w, r)
	if !ok {
		return
	}
	catalog, err := BuildSkillCatalog(view.Skills, roots)
	if err != nil {
		writeSettingsError(w, http.StatusInternalServerError, err.Error())
		return
	}
	catalog.ReadOnly = view.ReadOnly
	catalog.ReadOnlyReason = view.ReadOnlyReason
	catalog.ConfigRevision = view.ConfigRevision
	writeSettingsJSON(w, http.StatusOK, catalog)
}

// SkillDetail serves GET /settings/agent/skills/detail?id=<skill id>.
func (h *Handler) SkillDetail(w http.ResponseWriter, r *http.Request) {
	view, roots, ok := h.skillsContext(w, r)
	if !ok {
		return
	}
	detail, err := ReadSkillDetail(view.Skills, roots, r.URL.Query().Get("id"))
	if errors.Is(err, errSkillNotFound) {
		writeSettingsError(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		writeSettingsError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeSettingsJSON(w, http.StatusOK, detail)
}

func (h *Handler) skillsContext(w http.ResponseWriter, r *http.Request) (AgentSettingsView, []string, bool) {
	if r.Method != http.MethodGet {
		writeSettingsError(w, http.StatusMethodNotAllowed, "method not allowed")
		return AgentSettingsView{}, nil, false
	}
	if h == nil || h.owner == nil {
		writeSettingsError(w, http.StatusServiceUnavailable, "agent settings are unavailable")
		return AgentSettingsView{}, nil, false
	}
	view, err := h.owner.View(r.Context())
	if err != nil {
		writeSettingsError(w, settingsErrorStatus(err), err.Error())
		return AgentSettingsView{}, nil, false
	}
	reader, ok := h.currentReader(w)
	if !ok {
		return AgentSettingsView{}, nil, false
	}
	return view, skillsutil.SkillsConfigFromReader(reader).Roots, true
}

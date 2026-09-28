package agentsettings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/skillinstall"
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
	// Source is where an installed skill came from; nil for skills added by hand.
	Source *SkillCatalogSource `json:"source,omitempty"`
	// Modified lists files changed since install.
	Modified []string `json:"modified,omitempty"`
}

type SkillCatalogSource struct {
	skillinstall.Source
	InstalledAt string `json:"installed_at,omitempty"`
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

var (
	errSkillNotFound     = errors.New("skill not found")
	errSkillNotRemovable = errors.New("only skills directly inside the skills folder can be removed here")
)

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
	var source *SkillCatalogSource
	var modified []string
	if prov, ok := skillinstall.ReadProvenance(skill.Dir); ok {
		source = &SkillCatalogSource{Source: prov.Source, InstalledAt: prov.InstalledAt.UTC().Format("2006-01-02T15:04:05Z")}
		modified = prov.ModifiedFiles(skill.Dir)
		sort.Strings(modified)
	}
	return SkillCatalogEntry{
		Source:       source,
		Modified:     modified,
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
		if !d.Type().IsRegular() || d.Name() == skillinstall.ProvenanceFile {
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

// EnableSkill switches an installed skill on: it turns skills on and, when a load list is in
// use, adds the skill to it. An empty list already loads every skill.
func EnableSkill(ctx context.Context, owner Owner, skillID string) error {
	view, err := owner.View(ctx)
	if err != nil {
		return err
	}
	current := view.Skills
	enabled := true
	var load []string
	switch {
	case !current.Enabled:
		load = []string{skillID}
	case loadsAllSkills(current.Load):
		return nil
	default:
		load = append([]string{}, current.Load...)
		for _, entry := range load {
			if strings.EqualFold(strings.TrimSpace(entry), skillID) {
				return nil
			}
		}
		load = append(load, skillID)
	}
	_, err = owner.Update(ctx, AgentSettingsUpdate{Skills: &SkillsSettingsUpdate{Enabled: &enabled, Load: &load}})
	return err
}

func loadsAllSkills(load []string) bool {
	count := 0
	for _, entry := range load {
		entry = strings.TrimSpace(entry)
		if entry == "*" {
			return true
		}
		if entry != "" {
			count++
		}
	}
	return count == 0
}

// SkillStoreEntry is a store skill with its install state on this agent.
type SkillStoreEntry struct {
	skillinstall.StoreSkill
	Installed        bool   `json:"installed"`
	InstalledVersion string `json:"installed_version,omitempty"`
	UpdateAvailable  bool   `json:"update_available,omitempty"`
}

type SkillStoreView struct {
	IndexURL  string            `json:"index_url"`
	Repo      string            `json:"repo"`
	FetchedAt string            `json:"fetched_at"`
	Skills    []SkillStoreEntry `json:"skills"`
}

// BuildSkillStoreView marks which store skills are installed (by provenance) and outdated.
func BuildSkillStoreView(index skillinstall.StoreIndex, catalog SkillCatalog) SkillStoreView {
	installed := map[string]*SkillCatalogSource{}
	for _, entry := range catalog.Skills {
		if entry.Source != nil && entry.Source.StoreID != "" {
			installed[strings.ToLower(entry.Source.StoreID)] = entry.Source
		}
	}
	view := SkillStoreView{Repo: index.Repo, Skills: []SkillStoreEntry{}}
	for _, skill := range index.Skills {
		item := SkillStoreEntry{StoreSkill: skill}
		if src, ok := installed[strings.ToLower(skill.ID)]; ok {
			item.Installed = true
			item.InstalledVersion = src.Version
			// Versions decide; the commit is only a fallback for entries without one.
			if src.Version != "" && skill.Version != "" {
				item.UpdateAvailable = src.Version != skill.Version
			} else {
				item.UpdateAvailable = src.Commit != skill.Commit
			}
		}
		view.Skills = append(view.Skills, item)
	}
	return view
}

// SkillStore serves GET /settings/agent/skills/store.
func (h *Handler) SkillStore(w http.ResponseWriter, r *http.Request) {
	view, roots, ok := h.skillsContext(w, r)
	if !ok {
		return
	}
	reader, _ := h.currentReader(w)
	indexURL := strings.TrimSpace(reader.GetString("skills.store.index_url"))
	if indexURL == "" {
		indexURL = skillinstall.DefaultStoreIndexURL
	}
	index, fetchedAt, err := skillinstall.DefaultStore().Index(r.Context(), indexURL)
	if err != nil {
		writeSettingsError(w, http.StatusBadGateway, err.Error())
		return
	}
	catalog, err := BuildSkillCatalog(view.Skills, roots)
	if err != nil {
		writeSettingsError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := BuildSkillStoreView(index, catalog)
	out.IndexURL = indexURL
	out.FetchedAt = fetchedAt.UTC().Format("2006-01-02T15:04:05Z")
	writeSettingsJSON(w, http.StatusOK, out)
}

// RemovedSkill is the result of RemoveSkill.
type RemovedSkill struct {
	ID  string `json:"id"`
	Dir string `json:"dir"`
}

// RemoveSkill deletes a discovered skill's folder and drops it from the load list. Only a
// direct child of a skills root can be removed; a linked folder loses its link, not its target.
func RemoveSkill(ctx context.Context, owner Owner, roots []string, id string) (RemovedSkill, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return RemovedSkill{}, errSkillNotFound
	}
	discovered, err := discoverSkillsWithFrontmatter(roots)
	if err != nil {
		return RemovedSkill{}, err
	}
	var dir string
	for _, skill := range discovered {
		if strings.EqualFold(strings.TrimSpace(skill.ID), id) {
			id, dir = strings.TrimSpace(skill.ID), skill.Dir
			break
		}
	}
	if dir == "" {
		return RemovedSkill{}, errSkillNotFound
	}
	if !isDirectChildOfRoot(dir, roots) {
		return RemovedSkill{}, errSkillNotRemovable
	}
	if err := os.RemoveAll(dir); err != nil {
		return RemovedSkill{}, err
	}
	// Keep the load list meaning the same: drop the id. If it was the only entry, turn automatic
	// loading off instead, since an empty list would load every skill.
	view, err := owner.View(ctx)
	if err != nil {
		return RemovedSkill{ID: id, Dir: dir}, nil
	}
	var kept []string
	found := false
	for _, entry := range view.Skills.Load {
		if strings.EqualFold(strings.TrimSpace(entry), id) {
			found = true
			continue
		}
		kept = append(kept, entry)
	}
	if found {
		update := &SkillsSettingsUpdate{Load: &kept}
		if len(kept) == 0 {
			kept, disabled := []string{}, false
			update = &SkillsSettingsUpdate{Enabled: &disabled, Load: &kept}
		}
		if _, err := owner.Update(ctx, AgentSettingsUpdate{Skills: update}); err != nil {
			return RemovedSkill{ID: id, Dir: dir}, fmt.Errorf("removed %s but could not update skills.load: %w", id, err)
		}
	}
	return RemovedSkill{ID: id, Dir: dir}, nil
}

func isDirectChildOfRoot(dir string, roots []string) bool {
	for _, root := range roots {
		rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(dir))
		if err == nil && rel != "." && rel != ".." && !strings.ContainsRune(rel, filepath.Separator) {
			return true
		}
	}
	return false
}

// RemoveSkillRoute serves POST /settings/agent/skills/remove with {"id": "<skill id>"}.
func (h *Handler) RemoveSkillRoute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeSettingsError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h == nil || h.owner == nil {
		writeSettingsError(w, http.StatusServiceUnavailable, "agent settings are unavailable")
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeSettingsError(w, http.StatusBadRequest, "invalid json")
		return
	}
	view, err := h.owner.View(r.Context())
	if err != nil {
		writeSettingsError(w, settingsErrorStatus(err), err.Error())
		return
	}
	if view.ReadOnly {
		writeSettingsError(w, http.StatusConflict, firstNonEmptyString(view.ReadOnlyReason, "agent settings are read-only"))
		return
	}
	reader, ok := h.currentReader(w)
	if !ok {
		return
	}
	removed, err := RemoveSkill(r.Context(), h.owner, skillsutil.SkillsConfigFromReader(reader).Roots, req.ID)
	switch {
	case errors.Is(err, errSkillNotFound):
		writeSettingsError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, errSkillNotRemovable):
		writeSettingsError(w, http.StatusConflict, err.Error())
	case err != nil:
		writeSettingsError(w, http.StatusInternalServerError, err.Error())
	default:
		writeSettingsJSON(w, http.StatusOK, removed)
	}
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

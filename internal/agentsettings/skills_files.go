package agentsettings

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/skillinstall"
	"github.com/quailyquaily/mistermorph/skills"
)

// The Skills page browses a skill's folder one directory at a time and previews one file at a
// time. Both are read-only and stay inside the skill's folder: paths are relative, every part
// of a path is checked before it is opened, links inside the folder are listed but never
// followed, and the folder is opened as an os.Root so a path swapped mid-request cannot leave it.
const (
	// Entries returned for one directory; the rest are reported as capped.
	maxSkillDirEntries = 500
	// Entries read from one directory before giving up, hidden ones included.
	maxSkillDirScan = 4 * maxSkillDirEntries
	// A previewed file is shown only when it is at most this large.
	maxSkillFilePreviewBytes = 256 * 1024
	// Longest relative path accepted.
	maxSkillRelPathBytes = 4096
)

// Entry kinds in a directory listing.
const (
	SkillEntryDir     = "dir"
	SkillEntryFile    = "file"
	SkillEntrySymlink = "symlink"
	SkillEntryOther   = "other"
)

// Preview kinds for one file.
const (
	SkillPreviewText        = "text"
	SkillPreviewBinary      = "binary"
	SkillPreviewTooLarge    = "too_large"
	SkillPreviewUnsupported = "unsupported"
)

// SkillDirEntry is one child of a listed directory. Path is relative to the skill folder and
// uses forward slashes.
type SkillDirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
	Size int64  `json:"size,omitempty"`
}

// SkillDirListing is one directory of a skill. Path is "" for the skill folder itself.
type SkillDirListing struct {
	ID      string          `json:"id"`
	Path    string          `json:"path"`
	Entries []SkillDirEntry `json:"entries"`
	Capped  bool            `json:"capped,omitempty"`
}

// SkillFilePreview is one file of a skill. Content is set only for text files.
type SkillFilePreview struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Kind    string `json:"kind"`
	Content string `json:"content"`
	Limit   int64  `json:"limit"`
}

// skillPathError is a refused or failed path, with the status and code the routes report.
type skillPathError struct {
	status  int
	code    string
	message string
}

func (e *skillPathError) Error() string { return e.message }

var (
	errSkillPathInvalid  = &skillPathError{http.StatusBadRequest, "invalid_path", "path must be relative to the skill folder, without . or .. parts"}
	errSkillPathNotFound = &skillPathError{http.StatusNotFound, "path_not_found", "no such file or folder in this skill"}
	errSkillPathSymlink  = &skillPathError{http.StatusForbidden, "symlink", "links inside a skill are not followed"}
	errSkillPathDenied   = &skillPathError{http.StatusForbidden, "access_denied", "the agent cannot read this path"}
	errSkillPathNotDir   = &skillPathError{http.StatusBadRequest, "not_directory", "path is not a folder"}
	errSkillPathNotFile  = &skillPathError{http.StatusBadRequest, "not_file", "path is a folder"}
	errSkillPathChanged  = &skillPathError{http.StatusConflict, "path_changed", "the path changed while it was read; try again"}
)

// ListSkillDir lists one directory of a discovered skill. Hidden folders (such as .git) and the
// install record are left out, as in the catalog's file list.
func ListSkillDir(roots []string, id, relPath string) (SkillDirListing, error) {
	skill, err := findSkill(roots, id)
	if err != nil {
		return SkillDirListing{}, err
	}
	parts, err := splitSkillRelPath(relPath)
	if err != nil {
		return SkillDirListing{}, err
	}
	root, err := openSkillRoot(skill.Dir)
	if err != nil {
		return SkillDirListing{}, err
	}
	defer root.Close()

	name := "."
	var checked fs.FileInfo
	if len(parts) > 0 {
		checked, err = lstatSkillPath(root, parts)
		if err != nil {
			return SkillDirListing{}, err
		}
		if !checked.IsDir() {
			return SkillDirListing{}, errSkillPathNotDir
		}
		name = filepath.Join(parts...)
	}
	dir, err := root.Open(name)
	if err != nil {
		return SkillDirListing{}, mapSkillPathError(err)
	}
	defer dir.Close()
	opened, err := dir.Stat()
	if err != nil {
		return SkillDirListing{}, mapSkillPathError(err)
	}
	if !opened.IsDir() || (checked != nil && !os.SameFile(checked, opened)) {
		return SkillDirListing{}, errSkillPathChanged
	}

	prefix := strings.Join(parts, "/")
	listing := SkillDirListing{ID: strings.TrimSpace(skill.ID), Path: prefix, Entries: []SkillDirEntry{}}
	scanned := 0
	for {
		batch, readErr := dir.ReadDir(128)
		for _, item := range batch {
			scanned++
			if hiddenSkillEntry(item.Name(), item.IsDir(), len(parts) == 0) {
				continue
			}
			if len(listing.Entries) >= maxSkillDirEntries {
				listing.Capped = true
				break
			}
			listing.Entries = append(listing.Entries, skillDirEntry(item, prefix))
		}
		if listing.Capped || errors.Is(readErr, io.EOF) || len(batch) == 0 {
			break
		}
		if readErr != nil {
			return SkillDirListing{}, mapSkillPathError(readErr)
		}
		if scanned >= maxSkillDirScan {
			listing.Capped = true
			break
		}
	}
	sortSkillDirEntries(listing.Entries, len(parts) == 0)
	return listing, nil
}

// ReadSkillFile previews one regular file of a discovered skill. Files over the preview limit
// are not read; files that are not UTF-8 text, or hold NUL bytes, are reported as binary.
func ReadSkillFile(roots []string, id, relPath string) (SkillFilePreview, error) {
	skill, err := findSkill(roots, id)
	if err != nil {
		return SkillFilePreview{}, err
	}
	parts, err := splitSkillRelPath(relPath)
	if err != nil {
		return SkillFilePreview{}, err
	}
	if len(parts) == 0 {
		return SkillFilePreview{}, errSkillPathNotFile
	}
	root, err := openSkillRoot(skill.Dir)
	if err != nil {
		return SkillFilePreview{}, err
	}
	defer root.Close()

	info, err := lstatSkillPath(root, parts)
	if err != nil {
		return SkillFilePreview{}, err
	}
	preview := SkillFilePreview{
		ID:    strings.TrimSpace(skill.ID),
		Path:  strings.Join(parts, "/"),
		Name:  parts[len(parts)-1],
		Limit: maxSkillFilePreviewBytes,
	}
	if info.IsDir() {
		return SkillFilePreview{}, errSkillPathNotFile
	}
	// Devices, sockets and pipes are never opened: reading one could block or have effects.
	if !info.Mode().IsRegular() {
		preview.Kind = SkillPreviewUnsupported
		return preview, nil
	}
	preview.Size = info.Size()
	if info.Size() > maxSkillFilePreviewBytes {
		preview.Kind = SkillPreviewTooLarge
		return preview, nil
	}

	file, err := root.OpenFile(filepath.Join(parts...), skillFileOpenFlags, 0)
	if err != nil {
		return SkillFilePreview{}, mapSkillPathError(err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return SkillFilePreview{}, mapSkillPathError(err)
	}
	// The path checked above must be the file that was opened.
	if !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		return SkillFilePreview{}, errSkillPathChanged
	}
	data, err := io.ReadAll(io.LimitReader(file, maxSkillFilePreviewBytes+1))
	if err != nil {
		return SkillFilePreview{}, mapSkillPathError(err)
	}
	preview.Size = int64(len(data))
	if len(data) > maxSkillFilePreviewBytes {
		preview.Size = opened.Size()
		preview.Kind = SkillPreviewTooLarge
		return preview, nil
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		preview.Kind = SkillPreviewBinary
		return preview, nil
	}
	preview.Kind = SkillPreviewText
	preview.Content = string(data)
	return preview, nil
}

// findSkill finds a discovered skill by id, so only skills under the roots can be browsed.
func findSkill(roots []string, id string) (skills.Skill, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return skills.Skill{}, errSkillNotFound
	}
	discovered, err := skills.Discover(skills.DiscoverOptions{Roots: roots})
	if err != nil {
		return skills.Skill{}, err
	}
	for _, skill := range discovered {
		if strings.EqualFold(strings.TrimSpace(skill.ID), id) {
			return skill, nil
		}
	}
	return skills.Skill{}, errSkillNotFound
}

// splitSkillRelPath accepts "", "." or a clean slash-separated relative path. Anything that
// would need cleaning (absolute, "..", ".", empty parts, backslashes, NUL) is refused rather
// than rewritten, so the page and the agent always agree on what a path names.
func splitSkillRelPath(raw string) ([]string, error) {
	if raw == "" || raw == "." {
		return nil, nil
	}
	if len(raw) > maxSkillRelPathBytes || !utf8.ValidString(raw) || strings.ContainsAny(raw, "\\\x00") {
		return nil, errSkillPathInvalid
	}
	if strings.HasPrefix(raw, "/") || filepath.IsAbs(raw) || filepath.VolumeName(raw) != "" {
		return nil, errSkillPathInvalid
	}
	parts := strings.Split(raw, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, errSkillPathInvalid
		}
	}
	return parts, nil
}

// openSkillRoot opens the skill folder. A linked skill folder is followed once, as the catalog
// does; nothing below it is.
func openSkillRoot(dir string) (*os.Root, error) {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, mapSkillPathError(err)
	}
	root, err := os.OpenRoot(real)
	if err != nil {
		return nil, mapSkillPathError(err)
	}
	return root, nil
}

// lstatSkillPath checks each part of a path from the skill folder down: no part may be a link,
// a hidden folder or the install record, and every part but the last must be a folder.
func lstatSkillPath(root *os.Root, parts []string) (fs.FileInfo, error) {
	var info fs.FileInfo
	for i := range parts {
		var err error
		info, err = root.Lstat(filepath.Join(parts[:i+1]...))
		if err != nil {
			return nil, mapSkillPathError(err)
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return nil, errSkillPathSymlink
		}
		if hiddenSkillEntry(parts[i], info.IsDir(), i == 0) {
			return nil, errSkillPathNotFound
		}
		if i < len(parts)-1 && !info.IsDir() {
			return nil, errSkillPathNotFound
		}
	}
	return info, nil
}

func hiddenSkillEntry(name string, isDir, atRoot bool) bool {
	if isDir && strings.HasPrefix(name, ".") {
		return true
	}
	return atRoot && name == skillinstall.ProvenanceFile
}

func skillDirEntry(item fs.DirEntry, prefix string) SkillDirEntry {
	entry := SkillDirEntry{Name: item.Name(), Path: item.Name()}
	if prefix != "" {
		entry.Path = prefix + "/" + item.Name()
	}
	mode := item.Type()
	switch {
	case mode&fs.ModeSymlink != 0:
		entry.Kind = SkillEntrySymlink
	case mode.IsDir():
		entry.Kind = SkillEntryDir
	case mode.IsRegular():
		entry.Kind = SkillEntryFile
		if info, err := item.Info(); err == nil {
			entry.Size = info.Size()
		}
	default:
		entry.Kind = SkillEntryOther
	}
	return entry
}

// sortSkillDirEntries puts SKILL.md first in the skill folder, then folders, then the rest,
// each by name.
func sortSkillDirEntries(entries []SkillDirEntry, atRoot bool) {
	rank := func(entry SkillDirEntry) int {
		switch {
		case atRoot && entry.Name == "SKILL.md" && entry.Kind == SkillEntryFile:
			return 0
		case entry.Kind == SkillEntryDir:
			return 1
		default:
			return 2
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if ri, rj := rank(entries[i]), rank(entries[j]); ri != rj {
			return ri < rj
		}
		if li, lj := strings.ToLower(entries[i].Name), strings.ToLower(entries[j].Name); li != lj {
			return li < lj
		}
		return entries[i].Name < entries[j].Name
	})
}

func mapSkillPathError(err error) error {
	var pathErr *skillPathError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &pathErr):
		return pathErr
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOTDIR):
		return errSkillPathNotFound
	case errors.Is(err, fs.ErrPermission):
		return errSkillPathDenied
	case errors.Is(err, syscall.ELOOP):
		return errSkillPathSymlink
	case strings.Contains(err.Error(), "path escapes from parent"):
		// os.Root refuses a link that leads out of the skill folder.
		return errSkillPathSymlink
	default:
		return err
	}
}

func writeSkillPathError(w http.ResponseWriter, err error) {
	var pathErr *skillPathError
	switch {
	case errors.As(err, &pathErr):
		writeSettingsJSON(w, pathErr.status, map[string]any{"ok": false, "error": pathErr.message, "code": pathErr.code})
	case errors.Is(err, errSkillNotFound):
		writeSettingsJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": err.Error(), "code": "skill_not_found"})
	default:
		writeSettingsError(w, http.StatusInternalServerError, err.Error())
	}
}

// SkillDir serves GET /settings/agent/skills/dir?id=<skill id>&path=<folder>.
func (h *Handler) SkillDir(w http.ResponseWriter, r *http.Request) {
	_, roots, ok := h.skillsContext(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	listing, err := ListSkillDir(roots, query.Get("id"), query.Get("path"))
	if err != nil {
		writeSkillPathError(w, err)
		return
	}
	writeSettingsJSON(w, http.StatusOK, listing)
}

// SkillFile serves GET /settings/agent/skills/file?id=<skill id>&path=<file>.
func (h *Handler) SkillFile(w http.ResponseWriter, r *http.Request) {
	_, roots, ok := h.skillsContext(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	preview, err := ReadSkillFile(roots, query.Get("id"), query.Get("path"))
	if err != nil {
		writeSkillPathError(w, err)
		return
	}
	writeSettingsJSON(w, http.StatusOK, preview)
}

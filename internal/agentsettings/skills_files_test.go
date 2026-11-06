package agentsettings

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/skillinstall"
	"github.com/spf13/viper"
)

// newSkillFilesFixture creates <state>/skills/kit with nested folders, an empty folder, assorted
// text and binary files, hidden entries the browser skips, and a secret file outside the skill.
func newSkillFilesFixture(t *testing.T) (state, root, kit string) {
	t.Helper()
	state = t.TempDir()
	root = filepath.Join(state, "skills")
	kit = filepath.Join(root, "kit")
	writeSkillFile(t, filepath.Join(kit, "SKILL.md"), "---\nname: kit\ndescription: Tools.\n---\n# Kit\n")
	writeSkillFile(t, filepath.Join(kit, "README.md"), "# Readme\n\n<script>alert(1)</script>\n")
	writeSkillFile(t, filepath.Join(kit, "config.yaml"), "a:\n  b: 1\n\tc: tab\n")
	writeSkillFile(t, filepath.Join(kit, "empty.txt"), "")
	writeSkillFile(t, filepath.Join(kit, "scripts", "run.sh"), "#!/bin/sh\n  echo   \"hi\"\n")
	writeSkillFile(t, filepath.Join(kit, "references", "deep", "guide.md"), "## Guide\n")
	writeSkillFile(t, filepath.Join(kit, "assets", "logo.png"), "\x89PNG\r\n\x1a\n\x00\x00")
	writeSkillFile(t, filepath.Join(kit, "assets", "latin1.txt"), "caf\xe9\n")
	writeSkillFile(t, filepath.Join(kit, ".git", "config"), "[core]\n")
	writeSkillFile(t, filepath.Join(kit, ".env.example"), "TOKEN=\n")
	writeSkillFile(t, filepath.Join(kit, skillinstall.ProvenanceFile), "{}\n")
	if err := os.MkdirAll(filepath.Join(kit, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeSkillFile(t, filepath.Join(state, "secret.txt"), "top secret\n")
	writeSkillFile(t, filepath.Join(root, "other", "SKILL.md"), "---\nname: other\n---\nOther\n")
	return state, root, kit
}

func entryNames(entries []SkillDirEntry) string {
	var out []string
	for _, entry := range entries {
		out = append(out, entry.Name+":"+entry.Kind)
	}
	return strings.Join(out, ",")
}

func assertSkillPathError(t *testing.T, err error, want *skillPathError) {
	t.Helper()
	var got *skillPathError
	if !errors.As(err, &got) || got.code != want.code {
		t.Fatalf("error = %v, want %s", err, want.code)
	}
}

func TestListSkillDirNested(t *testing.T) {
	_, root, _ := newSkillFilesFixture(t)
	roots := []string{root}

	top, err := ListSkillDir(roots, "KIT", "")
	if err != nil {
		t.Fatalf("ListSkillDir(root) error = %v", err)
	}
	want := "SKILL.md:file,assets:dir,empty:dir,references:dir,scripts:dir,.env.example:file,config.yaml:file,empty.txt:file,README.md:file"
	if got := entryNames(top.Entries); got != want {
		t.Fatalf("root entries = %s\nwant %s", got, want)
	}
	if top.ID != "kit" || top.Path != "" || top.Capped {
		t.Fatalf("root listing = %+v", top)
	}
	if dot, err := ListSkillDir(roots, "kit", "."); err != nil || entryNames(dot.Entries) != want {
		t.Fatalf("ListSkillDir(.) = %v, %v", dot, err)
	}

	deep, err := ListSkillDir(roots, "kit", "references/deep")
	if err != nil {
		t.Fatalf("ListSkillDir(references/deep) error = %v", err)
	}
	if len(deep.Entries) != 1 || deep.Entries[0].Path != "references/deep/guide.md" || deep.Entries[0].Size != int64(len("## Guide\n")) {
		t.Fatalf("deep entries = %+v", deep.Entries)
	}

	empty, err := ListSkillDir(roots, "kit", "empty")
	if err != nil {
		t.Fatalf("ListSkillDir(empty) error = %v", err)
	}
	if empty.Entries == nil || len(empty.Entries) != 0 {
		t.Fatalf("empty entries = %#v, want an empty list", empty.Entries)
	}
	body, _ := json.Marshal(empty)
	if !strings.Contains(string(body), `"entries":[]`) {
		t.Fatalf("empty listing JSON = %s", body)
	}
}

func TestListSkillDirCapsLargeFolders(t *testing.T) {
	_, root, kit := newSkillFilesFixture(t)
	for i := 0; i < maxSkillDirEntries+5; i++ {
		writeSkillFile(t, filepath.Join(kit, "many", fmt.Sprintf("f%04d.txt", i)), "x")
	}
	listing, err := ListSkillDir([]string{root}, "kit", "many")
	if err != nil {
		t.Fatal(err)
	}
	if !listing.Capped || len(listing.Entries) != maxSkillDirEntries {
		t.Fatalf("capped=%v entries=%d", listing.Capped, len(listing.Entries))
	}
}

func TestReadSkillFileText(t *testing.T) {
	_, root, _ := newSkillFilesFixture(t)
	roots := []string{root}
	cases := map[string]string{
		"SKILL.md":                 "---\nname: kit\ndescription: Tools.\n---\n# Kit\n",
		"README.md":                "# Readme\n\n<script>alert(1)</script>\n",
		"config.yaml":              "a:\n  b: 1\n\tc: tab\n",
		"scripts/run.sh":           "#!/bin/sh\n  echo   \"hi\"\n",
		"references/deep/guide.md": "## Guide\n",
		".env.example":             "TOKEN=\n",
		"empty.txt":                "",
	}
	for path, want := range cases {
		t.Run(path, func(t *testing.T) {
			preview, err := ReadSkillFile(roots, "kit", path)
			if err != nil {
				t.Fatalf("ReadSkillFile() error = %v", err)
			}
			// Content comes back byte for byte: whitespace kept, markup not rendered or stripped.
			if preview.Kind != SkillPreviewText || preview.Content != want || preview.Size != int64(len(want)) {
				t.Fatalf("preview = %+v", preview)
			}
			if preview.Path != path || preview.Name != filepath.Base(path) || preview.Limit != maxSkillFilePreviewBytes {
				t.Fatalf("preview path/name/limit = %q %q %d", preview.Path, preview.Name, preview.Limit)
			}
		})
	}
}

func TestReadSkillFileBinaryAndTooLarge(t *testing.T) {
	_, root, kit := newSkillFilesFixture(t)
	roots := []string{root}
	writeSkillFile(t, filepath.Join(kit, "limit.txt"), strings.Repeat("a", maxSkillFilePreviewBytes))
	writeSkillFile(t, filepath.Join(kit, "big.txt"), strings.Repeat("a", maxSkillFilePreviewBytes+1))

	for _, path := range []string{"assets/logo.png", "assets/latin1.txt"} {
		preview, err := ReadSkillFile(roots, "kit", path)
		if err != nil || preview.Kind != SkillPreviewBinary || preview.Content != "" {
			t.Fatalf("ReadSkillFile(%s) = %+v, %v; want binary without content", path, preview, err)
		}
	}
	atLimit, err := ReadSkillFile(roots, "kit", "limit.txt")
	if err != nil || atLimit.Kind != SkillPreviewText || len(atLimit.Content) != maxSkillFilePreviewBytes {
		t.Fatalf("limit.txt = kind %q len %d, %v", atLimit.Kind, len(atLimit.Content), err)
	}
	big, err := ReadSkillFile(roots, "kit", "big.txt")
	if err != nil || big.Kind != SkillPreviewTooLarge || big.Content != "" || big.Size != maxSkillFilePreviewBytes+1 {
		t.Fatalf("big.txt = kind %q size %d content %d, %v", big.Kind, big.Size, len(big.Content), err)
	}
}

func TestSkillFilesRefuseEscapes(t *testing.T) {
	state, root, kit := newSkillFilesFixture(t)
	roots := []string{root}
	invalid := []string{
		"../other/SKILL.md",
		"..",
		"scripts/../SKILL.md",
		"./SKILL.md",
		"scripts//run.sh",
		"scripts/",
		"/etc/passwd",
		filepath.Join(state, "secret.txt"),
		`scripts\run.sh`,
		"SKILL.md\x00.txt",
		strings.Repeat("a/", maxSkillRelPathBytes),
	}
	for _, path := range invalid {
		if _, err := ReadSkillFile(roots, "kit", path); err == nil {
			t.Fatalf("ReadSkillFile(%q) succeeded", path)
		} else {
			assertSkillPathError(t, err, errSkillPathInvalid)
		}
		if _, err := ListSkillDir(roots, "kit", path); err == nil {
			t.Fatalf("ListSkillDir(%q) succeeded", path)
		} else {
			assertSkillPathError(t, err, errSkillPathInvalid)
		}
	}
	// Only discovered skills can be browsed; an id is never a path.
	for _, id := range []string{"", "missing", "../kit", kit, root} {
		if _, err := ListSkillDir(roots, id, ""); !errors.Is(err, errSkillNotFound) {
			t.Fatalf("ListSkillDir(id %q) error = %v, want skill not found", id, err)
		}
		if _, err := ReadSkillFile(roots, id, "SKILL.md"); !errors.Is(err, errSkillNotFound) {
			t.Fatalf("ReadSkillFile(id %q) error = %v, want skill not found", id, err)
		}
	}
}

func TestSkillFilesRefuseSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need extra privileges on Windows")
	}
	state, root, kit := newSkillFilesFixture(t)
	roots := []string{root}
	secret := filepath.Join(state, "secret.txt")
	mustSymlink := func(target, link string) {
		t.Helper()
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	mustSymlink(secret, filepath.Join(kit, "leak.txt"))
	mustSymlink(state, filepath.Join(kit, "outside"))
	mustSymlink("SKILL.md", filepath.Join(kit, "inside.md"))
	mustSymlink("scripts", filepath.Join(kit, "linked-scripts"))
	mustSymlink(filepath.Join(state, "missing"), filepath.Join(kit, "dangling"))

	top, err := ListSkillDir(roots, "kit", "")
	if err != nil {
		t.Fatal(err)
	}
	listed := entryNames(top.Entries)
	for _, want := range []string{"leak.txt:symlink", "outside:symlink", "inside.md:symlink", "linked-scripts:symlink", "dangling:symlink"} {
		if !strings.Contains(listed, want) {
			t.Fatalf("root entries %s, missing %s", listed, want)
		}
	}
	for _, path := range []string{"leak.txt", "inside.md", "dangling", "outside/secret.txt", "linked-scripts/run.sh"} {
		preview, err := ReadSkillFile(roots, "kit", path)
		if err == nil {
			t.Fatalf("ReadSkillFile(%s) = %+v, want refused", path, preview)
		}
		assertSkillPathError(t, err, errSkillPathSymlink)
	}
	for _, path := range []string{"outside", "linked-scripts"} {
		if _, err := ListSkillDir(roots, "kit", path); err == nil {
			t.Fatalf("ListSkillDir(%s) succeeded", path)
		} else {
			assertSkillPathError(t, err, errSkillPathSymlink)
		}
	}
}

func TestSkillFilesFollowLinkedSkillFolderOnce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need extra privileges on Windows")
	}
	state := t.TempDir()
	root := filepath.Join(state, "skills")
	real := filepath.Join(state, "elsewhere", "linked")
	writeSkillFile(t, filepath.Join(real, "SKILL.md"), "---\nname: linked\n---\nLinked\n")
	writeSkillFile(t, filepath.Join(real, "notes", "a.txt"), "a\n")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	listing, err := ListSkillDir([]string{root}, "linked", "notes")
	if err != nil || len(listing.Entries) != 1 {
		t.Fatalf("ListSkillDir() = %+v, %v", listing, err)
	}
	preview, err := ReadSkillFile([]string{root}, "linked", "notes/a.txt")
	if err != nil || preview.Content != "a\n" {
		t.Fatalf("ReadSkillFile() = %+v, %v", preview, err)
	}
}

func TestSkillFilesMissingHiddenAndWrongKind(t *testing.T) {
	_, root, _ := newSkillFilesFixture(t)
	roots := []string{root}
	for _, path := range []string{"missing.txt", "scripts/missing.sh", "SKILL.md/child", ".git/config", ".git", skillinstall.ProvenanceFile} {
		if _, err := ReadSkillFile(roots, "kit", path); err == nil {
			t.Fatalf("ReadSkillFile(%s) succeeded", path)
		} else {
			assertSkillPathError(t, err, errSkillPathNotFound)
		}
	}
	for _, path := range []string{"missing", ".git"} {
		if _, err := ListSkillDir(roots, "kit", path); err == nil {
			t.Fatalf("ListSkillDir(%s) succeeded", path)
		} else {
			assertSkillPathError(t, err, errSkillPathNotFound)
		}
	}
	if _, err := ListSkillDir(roots, "kit", "SKILL.md"); err == nil {
		t.Fatal("listing a file succeeded")
	} else {
		assertSkillPathError(t, err, errSkillPathNotDir)
	}
	for _, path := range []string{"", ".", "scripts"} {
		if _, err := ReadSkillFile(roots, "kit", path); err == nil {
			t.Fatalf("ReadSkillFile(%q) succeeded", path)
		} else {
			assertSkillPathError(t, err, errSkillPathNotFile)
		}
	}
}

func TestSkillFilesPermissionDenied(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs POSIX permissions and a non-root user")
	}
	_, root, kit := newSkillFilesFixture(t)
	locked := filepath.Join(kit, "locked")
	writeSkillFile(t, filepath.Join(locked, "inner.txt"), "x")
	writeSkillFile(t, filepath.Join(kit, "private.txt"), "x")
	if err := os.Chmod(filepath.Join(kit, "private.txt"), 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	if _, err := ListSkillDir([]string{root}, "kit", "locked"); err == nil {
		t.Fatal("listing a locked folder succeeded")
	} else {
		assertSkillPathError(t, err, errSkillPathDenied)
	}
	if _, err := ReadSkillFile([]string{root}, "kit", "private.txt"); err == nil {
		t.Fatal("reading an unreadable file succeeded")
	} else {
		assertSkillPathError(t, err, errSkillPathDenied)
	}
}

func TestHandlerSkillFileRoutes(t *testing.T) {
	state, _, _ := newSkillFilesFixture(t)
	reader := viper.New()
	reader.Set("file_state_dir", state)
	reader.Set("skills.dir_name", "skills")
	// Browsing is read-only, so it works on read-only agents too.
	owner := &handlerTestOwner{view: AgentSettingsView{ReadOnly: true, ReadOnlyReason: "managed"}, reader: reader}
	handler := NewHandler(HandlerOptions{Owner: owner})

	call := func(serve http.HandlerFunc, method, target string) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		rec := httptest.NewRecorder()
		serve(rec, httptest.NewRequest(method, target, nil))
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: invalid JSON %q", target, rec.Body.String())
		}
		return rec, body
	}

	rec, body := call(handler.SkillDir, http.MethodGet, "/settings/agent/skills/dir?id=kit&path=references")
	if rec.Code != http.StatusOK || body["path"] != "references" {
		t.Fatalf("dir status = %d (%v)", rec.Code, body)
	}
	rec, body = call(handler.SkillFile, http.MethodGet, "/settings/agent/skills/file?id=kit&path=scripts%2Frun.sh")
	if rec.Code != http.StatusOK || body["kind"] != SkillPreviewText || body["content"] != "#!/bin/sh\n  echo   \"hi\"\n" {
		t.Fatalf("file status = %d (%v)", rec.Code, body)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("file content type = %q", got)
	}

	errorsWanted := []struct {
		serve  http.HandlerFunc
		target string
		status int
		code   string
	}{
		{handler.SkillFile, "/settings/agent/skills/file?id=kit&path=..%2F..%2Fsecret.txt", http.StatusBadRequest, "invalid_path"},
		{handler.SkillDir, "/settings/agent/skills/dir?id=kit&path=%2Fetc", http.StatusBadRequest, "invalid_path"},
		{handler.SkillFile, "/settings/agent/skills/file?id=kit&path=nope.txt", http.StatusNotFound, "path_not_found"},
		{handler.SkillDir, "/settings/agent/skills/dir?id=nope", http.StatusNotFound, "skill_not_found"},
		{handler.SkillDir, "/settings/agent/skills/dir?id=kit&path=SKILL.md", http.StatusBadRequest, "not_directory"},
		{handler.SkillFile, "/settings/agent/skills/file?id=kit&path=scripts", http.StatusBadRequest, "not_file"},
	}
	for _, tc := range errorsWanted {
		rec, body := call(tc.serve, http.MethodGet, tc.target)
		if rec.Code != tc.status || body["code"] != tc.code {
			t.Fatalf("%s: status = %d (%v), want %d %s", tc.target, rec.Code, body, tc.status, tc.code)
		}
	}
	// Neither route writes anything.
	for _, serve := range []http.HandlerFunc{handler.SkillDir, handler.SkillFile} {
		rec, _ := call(serve, http.MethodPost, "/settings/agent/skills/file?id=kit&path=SKILL.md")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST status = %d, want 405", rec.Code)
		}
	}
}

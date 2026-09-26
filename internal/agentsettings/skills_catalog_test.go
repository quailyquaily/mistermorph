package agentsettings

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/skillsutil"
	"github.com/spf13/viper"
)

func writeSkillFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// newSkillsFixture creates <state>/skills with two skills: "jsonbill" (loaded, with a script,
// requirements and an auth profile, plus a .git folder to skip) and "notes" (not loaded).
func newSkillsFixture(t *testing.T) (string, []string, SkillsSettingsPayload) {
	t.Helper()
	state := t.TempDir()
	root := filepath.Join(state, "skills")
	writeSkillFile(t, filepath.Join(root, "jsonbill", "SKILL.md"), "---\nname: jsonbill\ndescription: Make and send JSON invoices.\nauth_profiles: [jsonbill_api]\nrequirements: [bash, curl]\n---\n\n# JSON bill\n\nUse `scripts/send.sh`.\n")
	writeSkillFile(t, filepath.Join(root, "jsonbill", "scripts", "send.sh"), "#!/bin/sh\necho sent\n")
	writeSkillFile(t, filepath.Join(root, "jsonbill", ".git", "config"), "[core]\n")
	writeSkillFile(t, filepath.Join(root, "notes", "SKILL.md"), "---\nname: Notes\ndescription: Keep notes.\n---\nBody\n")
	settings := SkillsSettingsPayload{
		Enabled: true,
		Load:    []string{"jsonbill"},
		Loaded:  []skillsutil.SkillStatusItem{{ID: "jsonbill", Name: "jsonbill"}},
	}
	return state, []string{root}, settings
}

func TestBuildSkillCatalog(t *testing.T) {
	_, roots, settings := newSkillsFixture(t)
	catalog, err := BuildSkillCatalog(settings, roots)
	if err != nil {
		t.Fatalf("BuildSkillCatalog() error = %v", err)
	}
	if !catalog.Enabled || len(catalog.Load) != 1 || len(catalog.Skills) != 2 {
		t.Fatalf("catalog = %+v", catalog)
	}
	bill, notes := catalog.Skills[0], catalog.Skills[1]
	if bill.ID != "jsonbill" || !bill.Loaded || bill.Description != "Make and send JSON invoices." {
		t.Fatalf("jsonbill entry = %+v", bill)
	}
	if strings.Join(bill.Requirements, ",") != "bash,curl" || strings.Join(bill.AuthProfiles, ",") != "jsonbill_api" {
		t.Fatalf("jsonbill requirements/auth = %v / %v", bill.Requirements, bill.AuthProfiles)
	}
	var paths []string
	for _, file := range bill.Files {
		paths = append(paths, file.Path)
	}
	if strings.Join(paths, ",") != "SKILL.md,scripts/send.sh" {
		t.Fatalf("jsonbill files = %v, want SKILL.md first and .git skipped", paths)
	}
	if notes.Name != "Notes" || notes.Loaded {
		t.Fatalf("notes entry = %+v", notes)
	}
}

func TestBuildSkillCatalogEmptyRoot(t *testing.T) {
	catalog, err := BuildSkillCatalog(SkillsSettingsPayload{Enabled: true}, []string{filepath.Join(t.TempDir(), "missing")})
	if err != nil {
		t.Fatalf("BuildSkillCatalog() error = %v", err)
	}
	if catalog.Skills == nil || len(catalog.Skills) != 0 {
		t.Fatalf("skills = %#v, want empty list", catalog.Skills)
	}
}

func TestReadSkillDetail(t *testing.T) {
	_, roots, settings := newSkillsFixture(t)
	detail, err := ReadSkillDetail(settings, roots, "JSONBILL")
	if err != nil {
		t.Fatalf("ReadSkillDetail() error = %v", err)
	}
	if detail.ID != "jsonbill" || !strings.Contains(detail.Content, "# JSON bill") || detail.ContentTruncated {
		t.Fatalf("detail = %+v", detail)
	}
	for _, id := range []string{"", "missing", "../notes", roots[0]} {
		if _, err := ReadSkillDetail(settings, roots, id); err != errSkillNotFound {
			t.Fatalf("ReadSkillDetail(%q) error = %v, want not found", id, err)
		}
	}
}

func TestReadSkillDetailTruncatesLargeContent(t *testing.T) {
	root := filepath.Join(t.TempDir(), "skills")
	body := "---\nname: big\n---\n" + strings.Repeat("é", maxSkillDetailBytes)
	writeSkillFile(t, filepath.Join(root, "big", "SKILL.md"), body)
	detail, err := ReadSkillDetail(SkillsSettingsPayload{}, []string{root}, "big")
	if err != nil {
		t.Fatalf("ReadSkillDetail() error = %v", err)
	}
	if !detail.ContentTruncated || len(detail.Content) > maxSkillDetailBytes || !strings.HasPrefix(detail.Content, "---") {
		t.Fatalf("truncated=%v len=%d", detail.ContentTruncated, len(detail.Content))
	}
	if !utf8.ValidString(detail.Content) {
		t.Fatal("truncation split a UTF-8 sequence")
	}
}

func TestHandlerSkillsRoutes(t *testing.T) {
	state, _, settings := newSkillsFixture(t)
	reader := viper.New()
	reader.Set("file_state_dir", state)
	reader.Set("skills.dir_name", "skills")
	owner := &handlerTestOwner{view: AgentSettingsView{Skills: settings, ReadOnly: true, ReadOnlyReason: "managed"}, reader: reader}
	handler := NewHandler(HandlerOptions{Owner: owner})

	list := httptest.NewRecorder()
	handler.Skills(list, httptest.NewRequest(http.MethodGet, "/settings/agent/skills", nil))
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", list.Code, list.Body.String())
	}
	var catalog SkillCatalog
	if err := json.Unmarshal(list.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Skills) != 2 || !catalog.ReadOnly || catalog.ReadOnlyReason != "managed" {
		t.Fatalf("catalog = %+v", catalog)
	}

	detail := httptest.NewRecorder()
	handler.SkillDetail(detail, httptest.NewRequest(http.MethodGet, "/settings/agent/skills/detail?id=notes", nil))
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), "Body") {
		t.Fatalf("detail status = %d (%s)", detail.Code, detail.Body.String())
	}

	missing := httptest.NewRecorder()
	handler.SkillDetail(missing, httptest.NewRequest(http.MethodGet, "/settings/agent/skills/detail?id=nope", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d, want 404", missing.Code)
	}

	post := httptest.NewRecorder()
	handler.Skills(post, httptest.NewRequest(http.MethodPost, "/settings/agent/skills", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", post.Code)
	}
}

package agentsettings

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/skillinstall"
)

type fakeSkillsOwner struct {
	Owner
	skills  SkillsSettingsPayload
	updates []SkillsSettingsUpdate
}

func (o *fakeSkillsOwner) View(context.Context) (AgentSettingsView, error) {
	return AgentSettingsView{Skills: o.skills}, nil
}

func (o *fakeSkillsOwner) Update(_ context.Context, u AgentSettingsUpdate) (AgentSettingsView, error) {
	o.updates = append(o.updates, *u.Skills)
	return AgentSettingsView{}, nil
}

func TestEnableSkill(t *testing.T) {
	cases := []struct {
		name     string
		enabled  bool
		load     []string
		wantLoad *[]string
	}{
		{name: "skills off loads only the new skill", enabled: false, load: []string{"a"}, wantLoad: &[]string{"pdf"}},
		{name: "empty list already loads all", enabled: true, load: nil},
		{name: "star already loads all", enabled: true, load: []string{"*"}},
		{name: "appends to a list", enabled: true, load: []string{"a"}, wantLoad: &[]string{"a", "pdf"}},
		{name: "already listed", enabled: true, load: []string{"PDF"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			owner := &fakeSkillsOwner{skills: SkillsSettingsPayload{Enabled: tc.enabled, Load: tc.load}}
			if err := EnableSkill(context.Background(), owner, "pdf"); err != nil {
				t.Fatal(err)
			}
			if tc.wantLoad == nil {
				if len(owner.updates) != 0 {
					t.Fatalf("expected no update, got %+v", owner.updates)
				}
				return
			}
			if len(owner.updates) != 1 || !*owner.updates[0].Enabled || !reflect.DeepEqual(*owner.updates[0].Load, *tc.wantLoad) {
				t.Fatalf("update = %+v, want load %v", owner.updates, *tc.wantLoad)
			}
		})
	}
}

func TestBuildSkillStoreView(t *testing.T) {
	index := skillinstall.StoreIndex{Repo: "o/store", Skills: []skillinstall.StoreSkill{
		{ID: "pdf", Version: "1.1.0", Commit: "c2"},
		{ID: "same", Version: "1.0.0", Commit: "c1"},
		{ID: "fresh", Version: "0.1.0", Commit: "c1"},
	}}
	catalog := SkillCatalog{Skills: []SkillCatalogEntry{
		{ID: "pdf", Source: &SkillCatalogSource{Source: skillinstall.Source{StoreID: "pdf", Version: "1.0.0", Commit: "c1"}}},
		{ID: "same", Source: &SkillCatalogSource{Source: skillinstall.Source{StoreID: "same", Version: "1.0.0", Commit: "c1"}}},
		{ID: "fresh"}, // same name, added by hand: not from the store
	}}
	view := BuildSkillStoreView(index, catalog)
	got := map[string]SkillStoreEntry{}
	for _, s := range view.Skills {
		got[s.ID] = s
	}
	if !got["pdf"].Installed || !got["pdf"].UpdateAvailable || got["pdf"].InstalledVersion != "1.0.0" {
		t.Fatalf("pdf = %+v", got["pdf"])
	}
	if !got["same"].Installed || got["same"].UpdateAvailable {
		t.Fatalf("same = %+v", got["same"])
	}
	if got["fresh"].Installed {
		t.Fatalf("fresh = %+v", got["fresh"])
	}
}

func TestSkillCatalogReadsProvenance(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "pdf")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: pdf\ndescription: PDFs\n---\n# PDF\n"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	prov := `{"source":{"kind":"store","url":"https://github.com/o/store/tree/c1/skills/pdf","store_id":"pdf","version":"1.0.0","commit":"c1"},"installed_at":"2026-09-26T00:00:00Z","files":{"SKILL.md":"0000"}}`
	if err := os.WriteFile(filepath.Join(dir, skillinstall.ProvenanceFile), []byte(prov), 0o644); err != nil {
		t.Fatal(err)
	}
	catalog, err := BuildSkillCatalog(SkillsSettingsPayload{Enabled: true}, []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Skills) != 1 {
		t.Fatalf("skills = %+v", catalog.Skills)
	}
	entry := catalog.Skills[0]
	if entry.Source == nil || entry.Source.StoreID != "pdf" || entry.Source.InstalledAt != "2026-09-26T00:00:00Z" {
		t.Fatalf("source = %+v", entry.Source)
	}
	if !reflect.DeepEqual(entry.Modified, []string{"SKILL.md"}) {
		t.Fatalf("modified = %v", entry.Modified)
	}
	for _, f := range entry.Files {
		if f.Path == skillinstall.ProvenanceFile {
			t.Fatal("provenance file listed")
		}
	}
}

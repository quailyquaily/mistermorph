package statefiles

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/personastore"
)

func locationsFor(state string) Locations {
	return Locations{
		ConfigPath:  configstore.DBConfigPath(state),
		StateDir:    state,
		ContactsDir: filepath.Join(state, "contacts"),
		CronPath:    filepath.Join(state, "cron.yaml"),
	}
}

func seed(t *testing.T, loc Locations) {
	t.Helper()
	ctx := context.Background()
	if err := configstore.WriteFileBy(loc.ConfigPath, []byte("llm:\n  model: m\n  api_key: ${KEY}\nheartbeat:\n  interval: 30m\n"), configstore.ByCLI); err != nil {
		t.Fatal(err)
	}
	persona, err := personastore.Open(ctx, loc.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = persona.Close() }()
	if _, err := persona.SaveIdentity(ctx, personastore.Identity{Name: "Morph", Emoji: "🦊", Soul: "## Core\n\nBe kind.",
		Extra: personastore.Extra{{Key: "pronouns", Value: "they"}}}, personastore.ByCLI); err != nil {
		t.Fatal(err)
	}
	if _, err := persona.ReplaceWorkflows(ctx, []personastore.Workflow{
		{Title: "Inbox", Instructions: "- Read it.", Enabled: true},
		{Title: "Weekly", Instructions: "- Report.", Enabled: false},
	}); err != nil {
		t.Fatal(err)
	}
	store := contacts.NewStore(loc.ContactsDir)
	last := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	if err := store.PutContact(ctx, contacts.Contact{ContactID: "tg:1", Kind: contacts.KindHuman, TGUserID: 1, ContactNickname: "Ann", LastInteractionAt: &last}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SetOwner(ctx, "tg:1", true); err != nil {
		t.Fatal(err)
	}
	if err := store.PutContact(ctx, contacts.Contact{ContactID: "mm:inst_b", Kind: contacts.KindAgent, Channel: contacts.ChannelAgentLink, Paired: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetContactStatus(ctx, "mm:inst_b", contacts.StatusInactive); err != nil {
		t.Fatal(err)
	}
	if err := cronstore.NewStore(loc.CronPath).Write(cronstore.File{Tasks: []cronstore.Task{
		{ID: "b", Cron: "0 9 * * *", Content: "Morning"},
		{ID: "a", At: "2030-01-01 09:00", TZ: "UTC", Content: "Once"},
	}}); err != nil {
		t.Fatal(err)
	}
}

func readAll(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		out[filepath.ToSlash(rel)] = string(raw)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestExportThenImportRoundTrips(t *testing.T) {
	ctx := context.Background()
	source := locationsFor(t.TempDir())
	seed(t, source)
	first := filepath.Join(t.TempDir(), "export")
	result, err := Export(ctx, source, first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(result.Files, ",") != "config.yaml,persona/identity.yaml,persona/soul.md,HEARTBEAT.md,contacts/ACTIVE.md,contacts/INACTIVE.md,cron.yaml" {
		t.Fatalf("files = %v", result.Files)
	}
	files := readAll(t, first)
	for rel, want := range map[string]string{
		"config.yaml":           "api_key: ${KEY}",
		"persona/identity.yaml": "pronouns: they",
		"persona/soul.md":       "Be kind.",
		"HEARTBEAT.md":          "## [off] Weekly",
		"contacts/ACTIVE.md":    "owner: true",
		"contacts/INACTIVE.md":  "paired: true",
		"cron.yaml":             "id: b",
	} {
		if !strings.Contains(files[rel], want) {
			t.Fatalf("%s lacks %q:\n%s", rel, want, files[rel])
		}
	}

	// Into a fresh state, and out again: the same files.
	target := locationsFor(t.TempDir())
	if _, err := Import(ctx, target, first); err != nil {
		t.Fatal(err)
	}
	second := filepath.Join(t.TempDir(), "export")
	if _, err := Export(ctx, target, second); err != nil {
		t.Fatal(err)
	}
	again := readAll(t, second)
	for _, rel := range []string{"contacts/ACTIVE.md", "contacts/INACTIVE.md"} {
		// The files' front matter has the time they were written.
		files[rel] = stripFrontMatter(files[rel])
		again[rel] = stripFrontMatter(again[rel])
	}
	if !reflect.DeepEqual(again, files) {
		for rel := range files {
			if files[rel] != again[rel] {
				t.Errorf("%s differs:\n%s\nvs\n%s", rel, files[rel], again[rel])
			}
		}
		t.FailNow()
	}
	// Importing the same files again changes nothing.
	if _, err := Import(ctx, target, first); err != nil {
		t.Fatal(err)
	}
	status, _, _, _ := contacts.NewStore(target.ContactsDir).ContactStatus(ctx, "mm:inst_b")
	if status != contacts.StatusInactive {
		t.Fatalf("status = %s", status)
	}
}

func TestImportParsesEverythingBeforeSaving(t *testing.T) {
	ctx := context.Background()
	target := locationsFor(t.TempDir())
	seed(t, target)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("llm:\n  model: changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cron.yaml"), []byte("version: 1\ntasks:\n  - id: bad\n    content: no schedule\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Import(ctx, target, dir); err == nil {
		t.Fatal("an invalid cron.yaml imported")
	}
	raw, _ := configstore.ReadFile(target.ConfigPath)
	if strings.Contains(string(raw), "changed") {
		t.Fatalf("config saved although cron.yaml was invalid:\n%s", raw)
	}
}

func stripFrontMatter(s string) string {
	if !strings.HasPrefix(s, "---\n") {
		return s
	}
	if end := strings.Index(s[4:], "\n---\n"); end >= 0 {
		return s[4+end+5:]
	}
	return s
}

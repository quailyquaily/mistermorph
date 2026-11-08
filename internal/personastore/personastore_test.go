package personastore

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/assets"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
)

func writeState(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func openStore(t *testing.T, dir string) *Store {
	t.Helper()
	store, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func template(t *testing.T, name string) string {
	t.Helper()
	raw, err := assets.ConfigFS.ReadFile("config/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestIdentityRoundTripsEveryField(t *testing.T) {
	ctx := context.Background()
	store := openStore(t, t.TempDir())
	if _, ok, err := store.Identity(ctx); err != nil || ok {
		t.Fatalf("empty state has an identity: %v, %v", ok, err)
	}
	want := Identity{
		Name: "Morph", NameAlts: []string{"M", "Mo"}, Creature: "fox", Vibe: "sharp", Emoji: "🦊",
		Soul:  "# Soul\n\nBe kind.",
		Extra: Extra{{Key: "pronouns", Value: "they"}, {Key: "age", Value: float64(3)}, {Key: "likes", Value: []any{"tea"}}},
	}
	got, err := store.SaveIdentity(ctx, want, ByCLI)
	if err != nil {
		t.Fatal(err)
	}
	if got.UpdatedBy != ByCLI || got.UpdatedAt == "" {
		t.Fatalf("updated = %q %q", got.UpdatedBy, got.UpdatedAt)
	}
	got.UpdatedAt, got.UpdatedBy = "", ""
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("identity = %#v\nwant %#v", got, want)
	}
	// Empty values stay empty, not missing.
	empty, err := store.SaveIdentity(ctx, Identity{}, ByCLI)
	if err != nil {
		t.Fatal(err)
	}
	if empty.NameAlts == nil || len(empty.NameAlts) != 0 || len(empty.Extra) != 0 || empty.Soul != "" {
		t.Fatalf("empty identity = %#v", empty)
	}
	name := "Patched"
	patched, err := store.PatchIdentity(ctx, IdentityPatch{Name: &name}, ByConsole)
	if err != nil || patched.Name != "Patched" || patched.UpdatedBy != ByConsole {
		t.Fatalf("patch = %+v, %v", patched, err)
	}
}

func TestIdentityYAMLKeepsShapeAndExtraKeys(t *testing.T) {
	raw := "name: Morph\nname_alts: [Mo]\ncreature: fox\nvibe: calm\nemoji: \"🦊\"\npronouns: they\nfavorites:\n  color: green\n"
	id, err := ParseIdentityYAML(raw)
	if err != nil {
		t.Fatal(err)
	}
	if id.Name != "Morph" || !reflect.DeepEqual(id.NameAlts, []string{"Mo"}) || len(id.Extra) != 2 || id.Extra[0].Key != "pronouns" || id.Extra[1].Key != "favorites" {
		t.Fatalf("parsed = %#v", id)
	}
	rendered := RenderIdentityYAML(id)
	if !strings.HasPrefix(rendered, "name: Morph\nname_alts: [Mo]\ncreature: fox\nvibe: calm\nemoji: \"🦊\"\npronouns: they\nfavorites:\n") {
		t.Fatalf("rendered:\n%s", rendered)
	}
	again, err := ParseIdentityYAML(rendered)
	if err != nil || !reflect.DeepEqual(again, id) {
		t.Fatalf("round trip = %#v, %v", again, err)
	}
	data, err := json.Marshal(id.Extra)
	if err != nil || string(data) != `{"pronouns":"they","favorites":{"color":"green"}}` {
		t.Fatalf("extra json = %s, %v", data, err)
	}
	// The template's empty identity renders as the template.
	tmpl, err := ParseIdentityYAML(template(t, "persona/identity.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if got := RenderIdentityYAML(tmpl); got != template(t, "persona/identity.yaml") {
		t.Fatalf("template rendered as:\n%s", got)
	}
	if _, err := ParseIdentityYAML("- a list"); err == nil {
		t.Fatal("a list identity parsed")
	}
}

func TestImportIdentityAndSoul(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	writeState(t, dir, map[string]string{
		"persona/identity.yaml": "name: Morph\ncreature: fox\nhome: the woods\n",
		"persona/soul.md":       "---\nstatus: final\n---\n# Soul\n\nBe brave.\n",
	})
	store := openStore(t, dir)
	id, ok, err := store.Identity(ctx)
	if err != nil || !ok {
		t.Fatalf("identity: %v, %v", ok, err)
	}
	if id.Name != "Morph" || id.Creature != "fox" || id.Soul != "# Soul\n\nBe brave." || id.UpdatedBy != ByImport ||
		len(id.Extra) != 1 || id.Extra[0].Key != "home" || id.Extra[0].Value != "the woods" {
		t.Fatalf("identity = %#v", id)
	}
	for _, name := range []string{"persona/identity.yaml", "persona/soul.md"} {
		if _, err := os.Stat(filepath.Join(dir, name+".imported")); err != nil {
			t.Fatalf("%s not renamed: %v", name, err)
		}
	}
	if LoadAgentName(ctx, dir) != "Morph" {
		t.Fatalf("agent name = %q", LoadAgentName(ctx, dir))
	}
}

func TestImportDraftSoulAsEmptyAndTemplates(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	writeState(t, dir, map[string]string{
		"persona/identity.yaml": template(t, "persona/identity.yaml"),
		"persona/soul.md":       "---\nstatus: draft\n---\n# Soul\n\nNot yet.\n",
		"HEARTBEAT.md":          template(t, "HEARTBEAT.md"),
	})
	store := openStore(t, dir)
	id, ok, err := store.Identity(ctx)
	if err != nil || !ok || id.Soul != "" || id.Name != "" {
		t.Fatalf("identity = %#v, %v, %v", id, ok, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "persona", "soul.md.imported")); err != nil {
		t.Fatalf("draft soul kept as imported file: %v", err)
	}
	workflows, err := store.Workflows(ctx)
	if err != nil || len(workflows) != 0 {
		t.Fatalf("template imported as %+v, %v", workflows, err)
	}
	if _, empty, err := store.HeartbeatTask(ctx); err != nil || !empty {
		t.Fatalf("template heartbeat not empty: %v", err)
	}
}

func TestImportMalformedIdentityIsRejectedAndKept(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	writeState(t, dir, map[string]string{
		"persona/identity.yaml": "name: [unclosed\n",
		"persona/soul.md":       "Kind.\n",
	})
	store := openStore(t, dir)
	id, ok, err := store.Identity(ctx)
	if err != nil || !ok || id.Soul != "Kind." {
		t.Fatalf("identity = %#v, %v, %v", id, ok, err)
	}
	rejects, err := agentdb.Rejects(ctx, store.DB(), "persona")
	if err != nil || rejects.Count != 1 || rejects.Rejects[0].Source != "persona/identity.yaml" {
		t.Fatalf("rejects = %+v, %v", rejects, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "persona", "identity.yaml")); err != nil {
		t.Fatalf("rejected file moved: %v", err)
	}
}

func TestParseChecklist(t *testing.T) {
	raw := "# Heartbeat Checklist\n\nCheck the inbox first.\n\n<!-- ## Hidden\n- no -->\n" +
		"## Contacts\n\n- Pick contacts with `contacts_list`.\n\n```md\n## not a heading\n```\n" +
		"## [off] Weekly report\n\n- Summarize the week.\n" +
		"## Empty\n"
	got := ParseChecklist(raw)
	want := []Workflow{
		{Title: DefaultWorkflowTitle, Instructions: "Check the inbox first.", Enabled: true},
		{Title: "Contacts", Instructions: "- Pick contacts with `contacts_list`.\n\n```md\n## not a heading\n```", Enabled: true},
		{Title: "Weekly report", Instructions: "- Summarize the week.", Enabled: false},
		{Title: "Empty", Instructions: "", Enabled: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed = %#v\nwant %#v", got, want)
	}
	again := ParseChecklist(RenderChecklist(got))
	if !reflect.DeepEqual(again, want) {
		t.Fatalf("render then parse = %#v", again)
	}
	if got := ParseChecklist(template(t, "HEARTBEAT.md")); len(got) != 0 {
		t.Fatalf("template parsed as %#v", got)
	}
}

func TestHeartbeatTaskFromEnabledWorkflowsOnly(t *testing.T) {
	ctx := context.Background()
	store := openStore(t, t.TempDir())
	if _, empty, err := store.HeartbeatTask(ctx); err != nil || !empty {
		t.Fatalf("no workflows gave a task: %v", err)
	}
	items, err := store.ReplaceWorkflows(ctx, []Workflow{
		{Title: "First", Instructions: "- one", Enabled: true},
		{Title: "Off", Instructions: "- skipped", Enabled: false},
		{Title: "Second", Instructions: "- two", Enabled: true},
	})
	if err != nil || len(items) != 3 || !strings.HasPrefix(items[0].ID, "hb-") || items[1].Position != 1 {
		t.Fatalf("items = %+v, %v", items, err)
	}
	task, empty, err := store.HeartbeatTask(ctx)
	if err != nil || empty || task != "## First\n\n- one\n\n## Second\n\n- two" {
		t.Fatalf("task = %q, %v, %v", task, empty, err)
	}
	// Reorder, switch off, edit, add, delete, keeping ids.
	off := false
	pos := 0
	moved, err := store.UpdateWorkflow(ctx, items[2].ID, WorkflowPatch{Position: &pos})
	if err != nil || moved.Position != 0 {
		t.Fatalf("move = %+v, %v", moved, err)
	}
	for _, w := range items {
		if _, err := store.UpdateWorkflow(ctx, w.ID, WorkflowPatch{Enabled: &off}); err != nil {
			t.Fatal(err)
		}
	}
	if _, empty, err := store.HeartbeatTask(ctx); err != nil || !empty {
		t.Fatalf("all off still gave a task: %v", err)
	}
	added, err := store.AddWorkflow(ctx, Workflow{Title: "New", Instructions: "- three", Enabled: true}, 1)
	if err != nil || added.Position != 1 {
		t.Fatalf("add = %+v, %v", added, err)
	}
	if err := store.DeleteWorkflow(ctx, items[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteWorkflow(ctx, items[0].ID); err != ErrWorkflowNotFound {
		t.Fatalf("second delete = %v", err)
	}
	list, _ := store.Workflows(ctx)
	titles := []string{}
	for _, w := range list {
		titles = append(titles, w.Title)
	}
	if strings.Join(titles, ",") != "Second,New,Off" {
		t.Fatalf("order = %v", titles)
	}
	if _, err := store.ReplaceWorkflows(ctx, []Workflow{{Title: ""}}); err == nil {
		t.Fatal("a workflow without a title saved")
	}
	// A checklist saved as text keeps the ids of the workflows whose titles it still has.
	parsed := MatchWorkflowIDs(ParseChecklist("## New\n\n- changed\n## Brand new\n\n- x\n"), list)
	if parsed[0].ID != list[1].ID || parsed[1].ID != "" {
		t.Fatalf("matched = %+v", parsed)
	}
}

func TestImportHeartbeatChecklist(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	writeState(t, dir, map[string]string{"HEARTBEAT.md": "# Heartbeat Checklist\n\n## Check\n\n- Review current state.\n"})
	store := openStore(t, dir)
	items, err := store.Workflows(ctx)
	if err != nil || len(items) != 1 || items[0].Title != "Check" || items[0].Instructions != "- Review current state." || !items[0].Enabled {
		t.Fatalf("workflows = %+v, %v", items, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "HEARTBEAT.md.imported")); err != nil {
		t.Fatalf("not renamed: %v", err)
	}
}

package contacts

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/assets"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
)

func newTestStore(t *testing.T) (*DBStore, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "contacts")
	return NewStore(root), root
}

func fullContact() Contact {
	cooldown := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	last := time.Date(2026, 3, 2, 11, 30, 0, 0, time.UTC)
	return Contact{
		ContactID: "tg:4242", Kind: KindHuman, Channel: ChannelTelegram, ContactNickname: "Everything",
		TGUsername: "every", TGUserID: 4242, TGPrivateChatID: 4242, TGGroupChatIDs: []int64{-1003, -1001},
		LineUserID: "Uline", LineChatIDs: []string{"Cline1", "Cline2"},
		LarkOpenID: "ou_lark", LarkChatIDs: []string{"oc_lark"},
		MixinUserID: "6b0f0a7e-1c39-4b5c-9d8b-6f1b1a2c3d4e", MixinIdentityNumber: "7000", MixinChatIDs: []string{"0d3f8c1a-2b4e-4f6a-8c9d-1e2f3a4b5c6d"},
		DiscordUserID: "111", DiscordDMChannelID: "222", DiscordChannelIDs: []string{"333", "444"},
		WeChatUserID: "wx_user", WhatsAppUserID: "15551234567", BlueskyUserID: "did:plc:abc", XUserID: "123456",
		SlackTeamID: "T1", SlackUserID: "U1", SlackDMChannelID: "D1", SlackChannelIDs: []string{"C1", "C2"},
		CooldownUntil: &cooldown, LastInteractionAt: &last,
	}
}

func TestDBStoreRoundTripsEveryField(t *testing.T) {
	ctx := context.Background()
	store, root := newTestStore(t)
	want, err := canonicalContact(fullContact())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PutContact(ctx, fullContact()); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.GetContact(ctx, "tg:4242")
	if err != nil || !ok {
		t.Fatalf("GetContact: %v, %v", ok, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("contact = %#v\nwant %#v", got, want)
	}
	// Empty and missing values stay empty.
	if err := store.PutContact(ctx, Contact{ContactID: "agent:bare", Kind: KindAgent}); err != nil {
		t.Fatal(err)
	}
	bare, _, err := store.GetContact(ctx, "agent:bare")
	if err != nil || bare.TGGroupChatIDs != nil || bare.LastInteractionAt != nil || bare.ContactNickname != "" || bare.Kind != KindAgent {
		t.Fatalf("bare = %#v, %v", bare, err)
	}
	// Nothing is written as a file.
	for _, name := range []string{"ACTIVE.md", "INACTIVE.md", "bus_inbox.json", "bus_outbox.json"} {
		if _, err := os.Stat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Fatalf("%s written: %v", name, err)
		}
	}
}

func TestDBStoreLooksUpEveryHandle(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	if err := store.PutContact(ctx, fullContact()); err != nil {
		t.Fatal(err)
	}
	stored, _, _ := store.GetContact(ctx, "tg:4242")
	for _, field := range handleFields {
		values := field.get(&stored)
		if len(values) == 0 {
			t.Fatalf("fixture has no %s", field.name)
		}
		for _, value := range values {
			found, err := store.FindContactsByHandle(ctx, field.name, value)
			if err != nil || len(found) != 1 || found[0].ContactID != "tg:4242" {
				t.Fatalf("%s=%s found %+v, %v", field.name, value, found, err)
			}
		}
	}
	if found, err := store.FindContactsByHandle(ctx, "tg_username", "EVERY"); err != nil || len(found) != 1 {
		t.Fatalf("username without case = %d, %v", len(found), err)
	}
	if _, err := store.FindContactsByHandle(ctx, "nickname", "x"); err == nil {
		t.Fatal("a field that is not a handle was accepted")
	}
}

func TestDBStoreSharedGroupChatFindsSeveralContacts(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	for i, id := range []string{"tg:1", "tg:2", "tg:3"} {
		groups := []int64{-100777}
		if i == 2 {
			groups = []int64{-100888}
		}
		if err := store.PutContact(ctx, Contact{ContactID: id, Kind: KindHuman, TGUserID: int64(i + 1), TGGroupChatIDs: groups}); err != nil {
			t.Fatal(err)
		}
	}
	found, err := store.FindContactsByHandle(ctx, "tg_group_chat_ids", "-100777")
	if err != nil || len(found) != 2 || found[0].ContactID != "tg:1" || found[1].ContactID != "tg:2" {
		t.Fatalf("found = %+v, %v", found, err)
	}
}

func TestDBStoreActiveLimitMovesTheOldest(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < maxActiveContacts+2; i++ {
		at := base.Add(time.Duration(i) * time.Hour)
		if err := store.PutContact(ctx, Contact{ContactID: fmt.Sprintf("tg:%d", 1000+i), Kind: KindHuman, LastInteractionAt: &at}); err != nil {
			t.Fatal(err)
		}
	}
	active, err := store.ListContacts(ctx, StatusActive)
	if err != nil || len(active) != maxActiveContacts {
		t.Fatalf("active = %d, %v", len(active), err)
	}
	for _, id := range []string{"tg:1000", "tg:1001"} {
		status, by, ok, err := store.ContactStatus(ctx, id)
		if err != nil || !ok || status != StatusInactive || by != DeactivatedByActiveLimit {
			t.Fatalf("%s = %s by %q, %v", id, status, by, err)
		}
	}
	// A person's own change clears the mark, and activating one moves the next oldest out.
	if _, err := store.SetContactStatus(ctx, "tg:1000", StatusActive); err != nil {
		t.Fatal(err)
	}
	if status, _, _, _ := store.ContactStatus(ctx, "tg:1000"); status != StatusInactive {
		// tg:1000 is the oldest, so the limit sends it straight back.
		t.Fatalf("oldest contact stayed active past the limit")
	}
}

func TestDBStoreKeepsStatusOwnerAndPaired(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	if err := store.PutContact(ctx, Contact{ContactID: "tg:1", Kind: KindHuman, Owner: true}); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := store.GetContact(ctx, "tg:1"); c.Owner {
		t.Fatal("PutContact set the owner flag")
	}
	if _, _, err := store.SetOwner(ctx, "tg:1", true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetContactStatus(ctx, "tg:1", StatusInactive); err != nil {
		t.Fatal(err)
	}
	if err := store.PutContact(ctx, Contact{ContactID: "tg:1", Kind: KindHuman, ContactNickname: "Seen again"}); err != nil {
		t.Fatal(err)
	}
	c, _, _ := store.GetContact(ctx, "tg:1")
	status, _, _, _ := store.ContactStatus(ctx, "tg:1")
	if !c.Owner || status != StatusInactive || c.ContactNickname != "Seen again" {
		t.Fatalf("contact = %+v (%s)", c, status)
	}
	// Pairing makes it active again.
	if err := store.PutContact(ctx, Contact{ContactID: "tg:1", Kind: KindHuman, Paired: true}); err != nil {
		t.Fatal(err)
	}
	if status, _, _, _ := store.ContactStatus(ctx, "tg:1"); status != StatusActive {
		t.Fatalf("paired contact status = %s", status)
	}
	// The YAML editor sets the owner and keeps the status.
	block, _, err := store.GetContactYAML(ctx, "tg:1")
	if err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(block.YAML, "owner: true", "owner: false", 1)
	edited = strings.Replace(edited, `nickname: ""`, `nickname: "Edited"`, 1)
	updated, err := store.PutContactYAML(ctx, "tg:1", edited)
	if err != nil || updated.Status != StatusActive || updated.Heading != "Edited" {
		t.Fatalf("PutContactYAML = %+v, %v", updated, err)
	}
	if c, _, _ := store.GetContact(ctx, "tg:1"); c.Owner {
		t.Fatal("YAML owner: false not saved")
	}
	if _, err := store.PutContactYAML(ctx, "tg:1", strings.Replace(edited, `contact_id: tg:1`, `contact_id: tg:2`, 1)); err == nil {
		t.Fatal("a changed contact_id was saved")
	}
	if _, deleted, err := store.DeleteContactYAML(ctx, "tg:1"); err != nil || !deleted {
		t.Fatalf("delete = %v, %v", deleted, err)
	}
	if found, _ := store.FindContactsByHandle(ctx, "tg_user_id", "1"); len(found) != 0 {
		t.Fatal("handles left after delete")
	}
}

func TestImportContactsFilesWithRejects(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "contacts")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	tmpl, err := assets.ConfigFS.ReadFile("config/contacts/ACTIVE.md")
	if err != nil {
		t.Fatal(err)
	}
	active := string(tmpl) + "\n## Alice\n\n```yaml\ncontact_id: \"tg:@alice\"\nnickname: \"Alice\"\nkind: \"human\"\nowner: true\n" +
		"tg_user_id: \"501\"\ntg_group_chat_ids:\n  - \"-100500\"\n```\n\n## Broken\n\n```yaml\ncontact_id: \"tg:9\"\nkind: \"robot\"\n```\n"
	inactive := "# Inactive Contacts\n\n## Bot\n\n```yaml\ncontact_id: \"mm:inst_x\"\nkind: \"agent\"\nchannel: \"agentlink\"\npaired: true\n```\n" +
		"\n## Alice again\n\n```yaml\ncontact_id: \"tg:@alice\"\nkind: \"human\"\n```\n"
	for name, body := range map[string]string{"ACTIVE.md": active, "INACTIVE.md": inactive} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	store := NewStore(root)
	listed, err := store.ListContactsFiltered(ctx, ContactFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 || listed[0].ContactID != "mm:inst_x" || listed[0].Status != StatusInactive || !listed[0].Paired ||
		listed[1].ContactID != "tg:@alice" || listed[1].Status != StatusActive || !listed[1].Owner || listed[1].TGUsername != "alice" {
		t.Fatalf("listed = %+v", listed)
	}
	db, err := store.db.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rejects, err := agentdb.Rejects(ctx, db, "contacts")
	if err != nil || rejects.Count != 2 {
		t.Fatalf("rejects = %+v, %v", rejects, err)
	}
	for _, name := range []string{"ACTIVE.md", "INACTIVE.md"} {
		if _, err := os.Stat(filepath.Join(root, name+".imported")); err != nil {
			t.Fatalf("%s not renamed: %v", name, err)
		}
	}
	if agents, err := store.ListContactsFiltered(ctx, ContactFilter{Kind: KindAgent, Channel: ChannelAgentLink}); err != nil || len(agents) != 1 {
		t.Fatalf("agents = %+v, %v", agents, err)
	}
	if has, err := store.HasActiveAgent(ctx); err != nil || has {
		t.Fatalf("HasActiveAgent = %v, %v; the only agent is inactive", has, err)
	}
}

func TestRenderAndParseContactsFiles(t *testing.T) {
	contact, err := canonicalContact(fullContact())
	if err != nil {
		t.Fatal(err)
	}
	active, inactive, err := RenderContactsFiles([]ListedContact{{Contact: contact, Status: StatusActive}})
	if err != nil || !strings.Contains(active, "contact_id: tg:4242") || strings.Contains(inactive, "tg:4242") {
		t.Fatalf("rendered = %q / %q, %v", active, inactive, err)
	}
	parsed, err := ParseContactsFile(active)
	if err != nil || len(parsed) != 1 {
		t.Fatalf("parsed = %+v, %v", parsed, err)
	}
	again, _ := canonicalContact(parsed[0])
	if !reflect.DeepEqual(again, contact) {
		t.Fatalf("round trip = %#v\nwant %#v", again, contact)
	}
}

// A contacts folder nested below the state folder (contacts.dir_name: address/people) is kept in
// the state folder's agent.db, where its files were imported; NewStore keeps agent.db above the
// contacts folder, for a contacts folder directly in its state folder.
func TestStoreInStateDirUsesTheStateAgentDB(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	nested := filepath.Join(state, "address", "people")
	if err := NewStoreInStateDir(state, nested).PutContact(ctx, Contact{ContactID: "tg:1", TGUserID: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(state, "address", "agent.db")); !os.IsNotExist(err) {
		t.Fatalf("agent.db opened above the nested contacts folder: %v", err)
	}
	// The same database through the default contacts folder.
	if _, ok, err := NewStore(filepath.Join(state, "contacts")).GetContact(ctx, "tg:1"); err != nil || !ok {
		t.Fatalf("contact in the state folder's agent.db: %v, %v", ok, err)
	}
	if _, ok, err := NewStoreInStateDir(" ", filepath.Join(state, "contacts")).GetContact(ctx, "tg:1"); err != nil || !ok {
		t.Fatalf("an empty state folder is NewStore's: %v, %v", ok, err)
	}
	if err := NewStoreInStateDir("", "").Ensure(ctx); err == nil {
		t.Fatal("a store with no folders opened a database")
	}
}

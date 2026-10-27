package memories

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/audience"
)

var (
	owner     = audience.Owner()
	aliceDM   = audience.Contact("tg:@alice")
	bobDM     = audience.Contact("tg:@bob")
	groupG    = audience.Audience{Kind: audience.KindConversation, ID: "tg:-100", Speaker: "tg:@alice"}
	groupH    = audience.Audience{Kind: audience.KindConversation, ID: "tg:-200", Speaker: "tg:@bob"}
	ownerInG  = audience.Audience{Kind: audience.KindConversation, ID: "tg:-100", Speaker: "tg:@owner", SpeakerIsOwner: true}
	noOne     = audience.Audience{}
	audiences = map[string]audience.Audience{"owner": owner, "alice": aliceDM, "bob": bobDM, "G": groupG, "H": groupH, "none": noOne}
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "memory.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func draft(subject, name string, typ Type, visibility Visibility) Draft {
	return Draft{Subject: subject, Name: name, Type: typ, Description: "about " + name, Body: "body of " + name, Visibility: visibility}
}

func mustSave(t *testing.T, s *Store, a audience.Audience, d Draft) Memory {
	t.Helper()
	res, err := s.Save(context.Background(), a, d)
	if err != nil {
		t.Fatalf("Save(%s, %s) error = %v", a.String(), d.Name, err)
	}
	return res.Memory
}

// TestVisibilityMatrix checks who hears each kind of memory, through CanHear and through the SQL
// filter search uses.
func TestVisibilityMatrix(t *testing.T) {
	s := openTestStore(t)
	cases := []struct {
		name    string
		from    audience.Audience
		draft   Draft
		hearers string
	}{
		{"owner-private-about-owner", owner, draft("owner", "owner-private", TypePerson, VisibilityPrivate), "owner"},
		{"owner-private-about-alice", owner, draft("contact:tg:@alice", "owner-note-alice", TypePerson, VisibilityPrivate), "owner"},
		{"owner-conversation-about-alice", owner, draft("contact:tg:@alice", "owner-conv-alice", TypePerson, VisibilityConversation), "alice,owner"},
		{"owner-public-general", owner, draft("general", "owner-public", TypeReference, VisibilityPublic), "G,H,alice,bob,owner"},
		{"alice-private-about-alice", aliceDM, draft("contact:tg:@alice", "alice-self", TypePerson, ""), "alice,owner"},
		{"alice-public-about-alice", aliceDM, draft("contact:tg:@alice", "alice-shared", TypePerson, VisibilityPublic), "G,H,alice,bob,owner"},
		{"alice-claim-about-bob", aliceDM, draft("contact:tg:@bob", "alice-says-bob", TypeContext, ""), "alice,owner"},
		// Alice said it in G (told_by), so her own DM hears it too.
		{"group-about-group", groupG, draft("conversation:tg:-100", "group-fact", TypeContext, ""), "G,alice,owner"},
		{"group-about-bob", groupG, draft("contact:tg:@bob", "group-says-bob", TypeContext, ""), "G,alice,bob,owner"},
		{"group-private", groupG, draft("conversation:tg:-100", "group-private", TypeContext, VisibilityPrivate), "owner"},
	}
	saved := map[string]Memory{}
	for _, tc := range cases {
		saved[tc.name] = mustSave(t, s, tc.from, tc.draft)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var heard []string
			for who, a := range audiences {
				canHear := CanHear(a, saved[tc.name])
				found := false
				items, _, err := s.Search(context.Background(), a, SearchOptions{Limit: 50})
				if err != nil {
					t.Fatalf("Search(%s) error = %v", who, err)
				}
				for _, m := range items {
					found = found || m.ID == saved[tc.name].ID
				}
				if canHear != found {
					t.Fatalf("%s: CanHear = %v but search found = %v", who, canHear, found)
				}
				if _, ok, _ := s.Get(context.Background(), a, saved[tc.name].ID); ok != canHear {
					t.Fatalf("%s: Get found = %v, want %v", who, ok, canHear)
				}
				if canHear {
					heard = append(heard, who)
				}
			}
			sort.Strings(heard)
			if got := strings.Join(heard, ","); got != tc.hearers {
				t.Fatalf("heard by %q, want %q", got, tc.hearers)
			}
		})
	}
}

func TestWriteRules(t *testing.T) {
	for _, tc := range []struct {
		name           string
		from           audience.Audience
		draft          Draft
		wantErr        string
		wantVisibility Visibility
		wantToldBy     string
		wantNote       bool
	}{
		{name: "owner writes general feedback", from: owner, draft: draft("general", "x", TypeFeedback, ""), wantVisibility: VisibilityPrivate},
		{name: "owner writes public", from: owner, draft: draft("owner", "x", TypePerson, VisibilityPublic), wantVisibility: VisibilityPublic},
		{name: "contact writes about self", from: aliceDM, draft: draft("contact:tg:@alice", "x", TypePerson, ""), wantVisibility: VisibilityPrivate, wantToldBy: "tg:@alice"},
		{name: "contact sets own feedback", from: aliceDM, draft: draft("contact:tg:@alice", "x", TypeFeedback, ""), wantVisibility: VisibilityPrivate, wantToldBy: "tg:@alice"},
		{name: "contact claim about other is narrowed", from: aliceDM, draft: draft("contact:tg:@bob", "x", TypePerson, VisibilityPublic), wantVisibility: VisibilityPrivate, wantToldBy: "tg:@alice", wantNote: true},
		{name: "contact cannot write general", from: aliceDM, draft: draft("general", "x", TypeContext, ""), wantErr: "direct message"},
		{name: "contact cannot write owner", from: aliceDM, draft: draft("owner", "x", TypePerson, ""), wantErr: "direct message"},
		{name: "contact cannot set feedback for another", from: aliceDM, draft: draft("contact:tg:@bob", "x", TypeFeedback, ""), wantErr: "only say how to work with them"},
		{name: "group fact", from: groupG, draft: draft("conversation:tg:-100", "x", TypeContext, ""), wantVisibility: VisibilityConversation, wantToldBy: "tg:@alice"},
		{name: "group cannot go public", from: groupG, draft: draft("conversation:tg:-100", "x", TypeContext, VisibilityPublic), wantVisibility: VisibilityConversation, wantToldBy: "tg:@alice", wantNote: true},
		{name: "group rule needs the owner", from: groupG, draft: draft("conversation:tg:-100", "x", TypeFeedback, ""), wantErr: "only the owner can set a rule"},
		{name: "owner sets group rule", from: ownerInG, draft: draft("conversation:tg:-100", "x", TypeFeedback, ""), wantVisibility: VisibilityConversation, wantToldBy: "tg:@owner"},
		{name: "group cannot write another group", from: groupG, draft: draft("conversation:tg:-200", "x", TypeContext, ""), wantErr: "in a group"},
		{name: "group cannot write general", from: groupG, draft: draft("general", "x", TypeContext, ""), wantErr: "in a group"},
		{name: "no audience", from: noOne, draft: draft("owner", "x", TypePerson, ""), wantErr: "no audience"},
		{name: "bad name", from: owner, draft: draft("owner", "Not A Slug", TypePerson, ""), wantErr: "kebab-case"},
		{name: "bad type", from: owner, draft: draft("owner", "x", "opinion", ""), wantErr: "type must be"},
		{name: "bad subject", from: owner, draft: draft("team:x", "x", TypePerson, ""), wantErr: "subject must be"},
		{name: "bad visibility", from: owner, draft: draft("owner", "x", TypePerson, "secret"), wantErr: "visibility must be"},
		{name: "multi-line description", from: owner, draft: Draft{Subject: "owner", Name: "x", Type: TypePerson, Description: "a\nb", Body: "b"}, wantErr: "one line"},
		{name: "empty body", from: owner, draft: Draft{Subject: "owner", Name: "x", Type: TypePerson, Description: "d"}, wantErr: "body"},
		{name: "body too long", from: owner, draft: Draft{Subject: "owner", Name: "x", Type: TypePerson, Description: "d", Body: strings.Repeat("x", maxBodyBytes+1)}, wantErr: "body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, err := openTestStore(t).Save(context.Background(), tc.from, tc.draft)
			if tc.wantErr != "" {
				var ruleErr *RuleError
				if err == nil || !errors.As(err, &ruleErr) || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("Save() error = %v, want a rule error containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Save() error = %v", err)
			}
			m := res.Memory
			if m.Visibility != tc.wantVisibility || m.ToldBy != tc.wantToldBy || m.LearnedIn != tc.from.String() {
				t.Fatalf("saved = visibility %s told_by %q learned_in %q; want %s %q %q", m.Visibility, m.ToldBy, m.LearnedIn, tc.wantVisibility, tc.wantToldBy, tc.from.String())
			}
			if (len(res.Notes) > 0) != tc.wantNote {
				t.Fatalf("notes = %v, want note=%v", res.Notes, tc.wantNote)
			}
		})
	}
}

func TestSaveReplacesWithinTheSameAudience(t *testing.T) {
	s := openTestStore(t)
	clock := time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	ctx := context.Background()

	first, err := s.Save(ctx, aliceDM, draft("contact:tg:@alice", "timezone", TypePerson, ""))
	if err != nil || !first.Created {
		t.Fatalf("first Save() = %#v, %v", first, err)
	}
	clock = clock.Add(time.Hour)
	update := draft("contact:tg:@alice", "timezone", TypePerson, "")
	update.Body = "Alice is in JST now."
	second, err := s.Save(ctx, aliceDM, update)
	if err != nil || second.Created || second.Memory.ID != first.Memory.ID {
		t.Fatalf("second Save() = %#v, %v; want the same memory replaced", second, err)
	}
	if second.Memory.CreatedAt != first.Memory.CreatedAt || second.Memory.UpdatedAt == first.Memory.UpdatedAt {
		t.Fatalf("times = created %s updated %s, want created kept and updated moved", second.Memory.CreatedAt, second.Memory.UpdatedAt)
	}
	// The same name from another audience is a memory of its own: it neither replaces Alice's nor
	// tells the writer hers exists.
	other := mustSave(t, s, owner, draft("contact:tg:@alice", "timezone", TypePerson, ""))
	if other.ID == first.Memory.ID {
		t.Fatal("owner's save replaced the memory Alice's conversation saved")
	}
	got, ok, _ := s.Get(ctx, aliceDM, first.Memory.ID)
	if !ok || got.Body != "Alice is in JST now." {
		t.Fatalf("Get() = %#v, %v", got, ok)
	}
}

func TestSaveCaps(t *testing.T) {
	s := openTestStore(t)
	for i := 0; i < MaxPerSubject; i++ {
		mustSave(t, s, aliceDM, draft("contact:tg:@alice", fmt.Sprintf("fact-%d", i), TypePerson, ""))
	}
	_, err := s.Save(context.Background(), aliceDM, draft("contact:tg:@alice", "one-more", TypePerson, ""))
	if err == nil || !strings.Contains(err.Error(), "merge this") {
		t.Fatalf("Save() past the cap error = %v, want a merge-or-forget refusal", err)
	}
	// Replacing one stays possible at the cap.
	if _, err := s.Save(context.Background(), aliceDM, draft("contact:tg:@alice", "fact-3", TypePerson, "")); err != nil {
		t.Fatalf("Save() replacing at the cap error = %v", err)
	}
}

func TestForgetRules(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	alices := mustSave(t, s, aliceDM, draft("contact:tg:@alice", "alice-self", TypePerson, ""))
	ownersShared := mustSave(t, s, owner, draft("contact:tg:@alice", "owner-conv-alice", TypePerson, VisibilityConversation))
	ownersPrivate := mustSave(t, s, owner, draft("owner", "owner-private", TypePerson, ""))

	if ok, err := s.Forget(ctx, aliceDM, ownersShared.ID); ok || err == nil {
		t.Fatalf("alice forgetting the owner's memory = %v, %v; want a refusal", ok, err)
	}
	if ok, err := s.Forget(ctx, aliceDM, ownersPrivate.ID); ok || err != nil {
		t.Fatalf("alice forgetting a memory she cannot hear = %v, %v; want not found", ok, err)
	}
	if ok, err := s.Forget(ctx, bobDM, alices.ID); ok || err != nil {
		t.Fatalf("bob forgetting alice's memory = %v, %v; want not found", ok, err)
	}
	if ok, err := s.Forget(ctx, aliceDM, alices.ID); !ok || err != nil {
		t.Fatalf("alice forgetting her own = %v, %v", ok, err)
	}
	if ok, err := s.Forget(ctx, owner, ownersShared.ID); !ok || err != nil {
		t.Fatalf("owner forgetting = %v, %v", ok, err)
	}
	if items, _, _ := s.Search(ctx, owner, SearchOptions{Query: "alice-self"}); len(items) != 0 {
		t.Fatalf("forgotten memory still found: %#v", items)
	}
}

func TestSearchText(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	for _, d := range []Draft{
		{Subject: "owner", Name: "release-notes", Type: TypeFeedback, Description: "Send release notes by DM", Body: "Release notes go to the owner as a DM, not to #eng."},
		{Subject: "owner", Name: "meeting", Type: TypeContext, Description: "定例会議は火曜", Body: "毎週火曜の十時に定例会議がある。"},
		{Subject: "general", Name: "wiki", Type: TypeReference, Description: "Where the wiki lives", Body: "https://wiki.example.com"},
	} {
		mustSave(t, s, owner, d)
	}
	for query, want := range map[string]string{
		"release notes": "release-notes",
		"会議":            "meeting",
		"定例会議":          "meeting",
		"DM":            "release-notes",
		"wiki.example":  "wiki",
		"nothing-here":  "",
	} {
		items, _, err := s.Search(ctx, owner, SearchOptions{Query: query})
		if err != nil {
			t.Fatalf("Search(%q) error = %v", query, err)
		}
		var names []string
		for _, m := range items {
			names = append(names, m.Name)
		}
		if got := strings.Join(names, ","); got != want {
			t.Fatalf("Search(%q) = %q, want %q", query, got, want)
		}
	}
	items, _, _ := s.Search(ctx, owner, SearchOptions{Type: TypeReference})
	if len(items) != 1 || items[0].Name != "wiki" {
		t.Fatalf("Search(type reference) = %#v", items)
	}
	items, more, _ := s.Search(ctx, owner, SearchOptions{Subject: "owner", Limit: 1})
	if len(items) != 1 || !more {
		t.Fatalf("Search(subject owner, limit 1) = %d items more=%v", len(items), more)
	}
}

func TestForPrompt(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustSave(t, s, owner, draft("owner", "owner-pref", TypeFeedback, ""))
	mustSave(t, s, owner, draft("general", "general-private", TypeReference, ""))
	mustSave(t, s, owner, draft("general", "general-public", TypeReference, VisibilityPublic))
	mustSave(t, s, owner, draft("contact:tg:@alice", "owner-note-alice", TypePerson, ""))
	mustSave(t, s, aliceDM, draft("contact:tg:@alice", "alice-self", TypePerson, ""))
	mustSave(t, s, aliceDM, draft("contact:tg:@alice", "alice-shared", TypePerson, VisibilityPublic))
	mustSave(t, s, groupG, draft("conversation:tg:-100", "group-fact", TypeContext, ""))
	mustSave(t, s, groupH, draft("conversation:tg:-200", "other-group", TypeContext, ""))

	for _, tc := range []struct {
		who          audience.Audience
		participants []string
		want         string
	}{
		{owner, nil, "general-private,general-public,owner-pref"},
		{aliceDM, nil, "alice-self,alice-shared,general-public"},
		{bobDM, nil, "general-public"},
		{groupG, nil, "general-public,group-fact"},
		{groupG, []string{"tg:@alice"}, "alice-shared,general-public,group-fact"},
		{noOne, nil, ""},
	} {
		items, _, err := s.ForPrompt(ctx, tc.who, tc.participants, 0)
		if err != nil {
			t.Fatalf("ForPrompt(%s) error = %v", tc.who.String(), err)
		}
		var names []string
		for _, m := range items {
			names = append(names, m.Name)
		}
		sort.Strings(names)
		if got := strings.Join(names, ","); got != tc.want {
			t.Fatalf("ForPrompt(%s, %v) = %q, want %q", tc.who.String(), tc.participants, got, tc.want)
		}
	}
}

func TestDeleteSubjectKeepsClaimsAboutOthers(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustSave(t, s, aliceDM, draft("contact:tg:@alice", "alice-self", TypePerson, ""))
	mustSave(t, s, owner, draft("contact:tg:@alice", "owner-note-alice", TypePerson, ""))
	claim := mustSave(t, s, aliceDM, draft("contact:tg:@bob", "alice-says-bob", TypeContext, ""))
	n, err := s.DeleteSubject(ctx, "contact:tg:@alice")
	if err != nil || n != 2 {
		t.Fatalf("DeleteSubject() = %d, %v; want 2", n, err)
	}
	items, err := s.List(ctx)
	if err != nil || len(items) != 1 || items[0].ID != claim.ID || items[0].ToldBy != "tg:@alice" {
		t.Fatalf("List() after delete = %#v, %v; want only alice's claim about bob", items, err)
	}
}

func TestReminderCount(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	for i := 1; i <= 3; i++ {
		if n, err := s.CountTurn(ctx, aliceDM); err != nil || n != i {
			t.Fatalf("CountTurn() = %d, %v; want %d", n, err, i)
		}
	}
	if _, due, _ := s.TakeReminder(ctx, aliceDM, 4); due {
		t.Fatal("TakeReminder(4) due after 3 turns")
	}
	if _, due, _ := s.TakeReminder(ctx, bobDM, 1); due {
		t.Fatal("TakeReminder() due for an audience with no turns")
	}
	if n, due, err := s.TakeReminder(ctx, aliceDM, 3); !due || n != 3 || err != nil {
		t.Fatalf("TakeReminder(3) = %d, %v, %v; want due at 3", n, due, err)
	}
	if _, due, _ := s.TakeReminder(ctx, aliceDM, 3); due {
		t.Fatal("TakeReminder() due again right after it was taken")
	}
	_, _ = s.CountTurn(ctx, aliceDM)
	_, _ = s.CountTurn(ctx, aliceDM)
	mustSave(t, s, aliceDM, draft("contact:tg:@alice", "alice-self", TypePerson, ""))
	if n, _ := s.CountTurn(ctx, aliceDM); n != 1 {
		t.Fatalf("CountTurn() after a save = %d, want 1: a save resets the count", n)
	}
}

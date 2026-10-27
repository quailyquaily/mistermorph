package audience

import (
	"context"
	"errors"
	"testing"

	"github.com/quailyquaily/mistermorph/contacts"
)

type fakeLookup struct {
	contacts map[string]contacts.Contact
	err      error
}

func (f fakeLookup) LookupSender(_ context.Context, sender contacts.InboundSender) (contacts.Contact, bool, error) {
	if f.err != nil {
		return contacts.Contact{}, false, f.err
	}
	for _, id := range contacts.SenderContactIDs(sender) {
		if c, ok := f.contacts[id]; ok {
			return c, true, nil
		}
	}
	return contacts.Contact{}, false, nil
}

func TestResolve(t *testing.T) {
	known := fakeLookup{contacts: map[string]contacts.Contact{
		"tg:@owner":         {ContactID: "tg:@owner", Owner: true},
		"tg:@alice":         {ContactID: "tg:@alice"},
		"slack:T1:U_OWNER":  {ContactID: "slack:T1:U_OWNER", Owner: true},
		"discord_user:4242": {ContactID: "discord_user:4242"},
	}}
	for _, tc := range []struct {
		name   string
		lookup SenderLookup
		in     Input
		want   string
	}{
		{"group is its conversation", known, Input{Group: true, ConversationKey: "tg:-100", Sender: contacts.InboundSender{Channel: "telegram", Username: "owner"}}, "conversation:tg:-100"},
		{"owner dm", known, Input{ConversationKey: "tg:1", Sender: contacts.InboundSender{Channel: "telegram", Username: "owner", UserID: "1"}}, "owner"},
		{"slack owner dm", known, Input{ConversationKey: "slack:T1:D1", Sender: contacts.InboundSender{Channel: "slack", TeamID: "T1", UserID: "U_OWNER"}}, "owner"},
		{"contact dm", known, Input{ConversationKey: "tg:2", Sender: contacts.InboundSender{Channel: "telegram", Username: "alice", UserID: "2"}}, "contact:tg:@alice"},
		{"discord contact dm", known, Input{ConversationKey: "discord:dm", Sender: contacts.InboundSender{Channel: "discord", UserID: "4242"}}, "contact:discord_user:4242"},
		{"unknown sender is the contact the observer records", known, Input{ConversationKey: "line:u", Sender: contacts.InboundSender{Channel: "line", UserID: "Uabc"}}, "contact:line_user:Uabc"},
		{"no sender is the conversation", known, Input{ConversationKey: "mixin:c1"}, "conversation:mixin:c1"},
		{"lookup error hears the least", fakeLookup{err: errors.New("disk")}, Input{ConversationKey: "tg:1", Sender: contacts.InboundSender{Channel: "telegram", Username: "owner"}}, "conversation:tg:1"},
		{"nothing known is no audience", nil, Input{}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Resolve(context.Background(), tc.lookup, tc.in).String(); got != tc.want {
				t.Fatalf("Resolve() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveGroupSpeaker(t *testing.T) {
	known := fakeLookup{contacts: map[string]contacts.Contact{
		"tg:@owner": {ContactID: "tg:@owner", Owner: true},
		"tg:@alice": {ContactID: "tg:@alice"},
	}}
	for _, tc := range []struct {
		username    string
		wantSpeaker string
		wantOwner   bool
	}{
		{"owner", "tg:@owner", true},
		{"alice", "tg:@alice", false},
		{"stranger", "tg:@stranger", false},
	} {
		got := Resolve(context.Background(), known, Input{Group: true, ConversationKey: "tg:-100", Sender: contacts.InboundSender{Channel: "telegram", Username: tc.username}})
		if got.String() != "conversation:tg:-100" || got.Speaker != tc.wantSpeaker || got.SpeakerIsOwner != tc.wantOwner {
			t.Fatalf("Resolve(%s in group) = %#v, want speaker %q owner=%v", tc.username, got, tc.wantSpeaker, tc.wantOwner)
		}
		if got.SpeakerContactID() != tc.wantSpeaker {
			t.Fatalf("SpeakerContactID() = %q", got.SpeakerContactID())
		}
	}
	if got := Contact("tg:@alice").SpeakerContactID(); got != "tg:@alice" {
		t.Fatalf("contact SpeakerContactID() = %q", got)
	}
	if got := Owner().SpeakerContactID(); got != "" {
		t.Fatalf("owner SpeakerContactID() = %q", got)
	}
}

func TestParseRoundTrip(t *testing.T) {
	for _, a := range []Audience{{}, Owner(), Contact("tg:@alice"), Conversation("slack:T1:C1:1700000000.1")} {
		got, err := Parse(a.String())
		if err != nil || got != a {
			t.Fatalf("Parse(%q) = %#v, %v; want %#v", a.String(), got, err, a)
		}
	}
	for _, raw := range []string{"contact:", "team:x", "conversation"} {
		if _, err := Parse(raw); err == nil {
			t.Fatalf("Parse(%q) error = nil", raw)
		}
	}
}

func TestContext(t *testing.T) {
	if got := FromContext(context.Background()); !got.IsZero() {
		t.Fatalf("FromContext(empty) = %#v", got)
	}
	ctx := NewContext(context.Background(), Contact("tg:@alice"))
	if got := FromContext(ctx); got != Contact("tg:@alice") {
		t.Fatalf("FromContext() = %#v", got)
	}
}

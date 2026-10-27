// Package audience says who can hear what the agent says in a run: the owner, one contact in a
// direct message, or everyone in a group conversation. Memories and journal search use it to decide
// what a run may see. The runtime computes it from what the channel reports; the model never picks
// it.
package audience

import (
	"context"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/contacts"
)

type Kind string

const (
	// KindOwner is the person who runs the agent: the Console, the TUI, or a direct message from a
	// contact marked as the owner.
	KindOwner Kind = "owner"
	// KindContact is one person in a direct message.
	KindContact Kind = "contact"
	// KindConversation is a group, channel or thread: a public square, whoever is in it.
	KindConversation Kind = "conversation"
)

// Audience is who hears a run. The zero value is no audience: the run sees no memories and no
// journal.
type Audience struct {
	Kind Kind
	// ID is the contact ID for KindContact and the runtime's conversation key for
	// KindConversation. It is empty for KindOwner.
	ID string
}

func Owner() Audience { return Audience{Kind: KindOwner} }

func Contact(contactID string) Audience {
	contactID = strings.TrimSpace(contactID)
	if contactID == "" {
		return Audience{}
	}
	return Audience{Kind: KindContact, ID: contactID}
}

func Conversation(conversationKey string) Audience {
	conversationKey = strings.TrimSpace(conversationKey)
	if conversationKey == "" {
		return Audience{}
	}
	return Audience{Kind: KindConversation, ID: conversationKey}
}

func (a Audience) IsZero() bool { return a.Kind == "" }

// String is the stored form: "owner", "contact:<id>" or "conversation:<key>". The zero value is "".
func (a Audience) String() string {
	switch a.Kind {
	case "":
		return ""
	case KindOwner:
		return string(KindOwner)
	default:
		return string(a.Kind) + ":" + a.ID
	}
}

// Parse reads the stored form. An empty string is the zero Audience.
func Parse(raw string) (Audience, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Audience{}, nil
	}
	if raw == string(KindOwner) {
		return Owner(), nil
	}
	kind, id, ok := strings.Cut(raw, ":")
	id = strings.TrimSpace(id)
	if !ok || id == "" {
		return Audience{}, fmt.Errorf("audience %q is invalid", raw)
	}
	switch Kind(kind) {
	case KindContact:
		return Contact(id), nil
	case KindConversation:
		return Conversation(id), nil
	}
	return Audience{}, fmt.Errorf("audience %q is invalid", raw)
}

// Input is what a channel knows about an inbound message.
type Input struct {
	// Group is true for anything but a direct message.
	Group           bool
	ConversationKey string
	Sender          contacts.InboundSender
}

// SenderLookup finds the stored contact of a sender; *contacts.Service implements it.
type SenderLookup interface {
	LookupSender(ctx context.Context, sender contacts.InboundSender) (contacts.Contact, bool, error)
}

// Resolve is the audience of a run started by an inbound message:
//   - a group is its conversation, even when the agent knows people in it;
//   - a direct message from a contact marked as the owner is the owner;
//   - any other direct message is that contact, or the contact the observer will record for an
//     unknown sender;
//   - a direct message with no usable sender is its conversation.
//
// A lookup error makes a direct message its conversation, which hears the least.
func Resolve(ctx context.Context, lookup SenderLookup, in Input) Audience {
	if in.Group {
		return Conversation(in.ConversationKey)
	}
	if lookup != nil {
		contact, ok, err := lookup.LookupSender(ctx, in.Sender)
		if err != nil {
			return Conversation(in.ConversationKey)
		}
		if ok {
			if contact.Owner {
				return Owner()
			}
			if a := Contact(contact.ContactID); !a.IsZero() {
				return a
			}
		}
	}
	if ids := contacts.SenderContactIDs(in.Sender); len(ids) > 0 {
		return Contact(ids[0])
	}
	return Conversation(in.ConversationKey)
}

type contextKey struct{}

// NewContext returns ctx carrying a run's audience.
func NewContext(ctx context.Context, a Audience) context.Context {
	return context.WithValue(ctx, contextKey{}, a)
}

// FromContext is the run's audience; the zero Audience when ctx has none.
func FromContext(ctx context.Context) Audience {
	if ctx == nil {
		return Audience{}
	}
	a, _ := ctx.Value(contextKey{}).(Audience)
	return a
}

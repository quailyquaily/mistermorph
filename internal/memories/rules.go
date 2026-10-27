// Package memories keeps the facts the agent saves on purpose: who someone is, how to work with
// them, a goal or a deadline, where something lives. Each memory is about a subject, was learned
// in one audience, and may be heard only by the audiences its visibility allows. The rules here
// decide that; the store applies them to every read and write.
package memories

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/audience"
)

type Type string

const (
	// TypePerson is who someone is: their role, what they care about, how they like to be
	// addressed.
	TypePerson Type = "person"
	// TypeFeedback is how to work: a correction or a confirmed approach, with its reason.
	TypeFeedback Type = "feedback"
	// TypeContext is a goal, a deadline or a constraint the records do not show.
	TypeContext Type = "context"
	// TypeReference is where something lives outside mistermorph.
	TypeReference Type = "reference"
)

type Visibility string

const (
	// VisibilityPrivate is heard by the owner and, for a memory learned in a contact's direct
	// message, by that contact.
	VisibilityPrivate Visibility = "private"
	// VisibilityConversation is heard by the owner, in the conversation it was learned in, and in
	// the direct messages of the contact it is about or who said it.
	VisibilityConversation Visibility = "conversation"
	// VisibilityPublic is heard everywhere.
	VisibilityPublic Visibility = "public"
)

// SubjectGeneral is a subject that is no one in particular: how to work in general, facts about
// the world. Only the owner writes it.
const SubjectGeneral = "general"

const (
	maxNameBytes        = 64
	maxDescriptionRunes = 200
	maxBodyBytes        = 4 << 10
	maxSourceEvents     = 20
)

var namePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

func widthOf(v Visibility) int {
	switch v {
	case VisibilityPrivate:
		return 0
	case VisibilityConversation:
		return 1
	case VisibilityPublic:
		return 2
	}
	return -1
}

// Memory is one saved fact.
type Memory struct {
	ID          string
	Subject     string
	Name        string
	Type        Type
	Description string
	Body        string
	Visibility  Visibility
	// LearnedIn is the audience the memory was saved from, in its stored form.
	LearnedIn string
	// ToldBy is the contact who said it; empty when the owner said it or the agent inferred it.
	ToldBy        string
	SourceEvents  []string
	CreatedAt     string
	UpdatedAt     string
	UpdatedByTask string
}

// CanHear reports whether a run with audience a may see m. Every read path checks it.
func CanHear(a audience.Audience, m Memory) bool {
	switch a.Kind {
	case audience.KindOwner:
		return true
	case audience.KindContact, audience.KindConversation:
	default:
		return false
	}
	if m.Visibility == VisibilityPublic {
		return true
	}
	here := a.String()
	switch a.Kind {
	case audience.KindContact:
		switch m.Visibility {
		case VisibilityPrivate:
			return m.LearnedIn == here
		case VisibilityConversation:
			return m.Subject == here || (m.ToldBy != "" && m.ToldBy == a.ID)
		}
	case audience.KindConversation:
		return m.Visibility == VisibilityConversation && m.LearnedIn == here
	}
	return false
}

// Draft is a memory as a run asks to save it.
type Draft struct {
	Subject      string
	Name         string
	Type         Type
	Description  string
	Body         string
	Visibility   Visibility
	SourceEvents []string
	TaskID       string
}

// RuleError is a save the rules refuse. Its message is written for the model.
type RuleError struct{ msg string }

func (e *RuleError) Error() string { return e.msg }

func refuse(format string, args ...any) error { return &RuleError{msg: fmt.Sprintf(format, args...)} }

// checkWrite validates d and applies the write rules for audience a. It returns the memory to
// store (without ID or times) and notes for the model, such as a narrowed visibility.
func checkWrite(a audience.Audience, d Draft) (Memory, []string, error) {
	if a.IsZero() {
		return Memory{}, nil, refuse("this run has no audience, so it cannot save memories")
	}
	m := Memory{
		Subject:       strings.TrimSpace(d.Subject),
		Name:          strings.TrimSpace(d.Name),
		Type:          Type(strings.TrimSpace(string(d.Type))),
		Description:   strings.TrimSpace(d.Description),
		Body:          strings.TrimSpace(d.Body),
		LearnedIn:     a.String(),
		ToldBy:        a.SpeakerContactID(),
		UpdatedByTask: strings.TrimSpace(d.TaskID),
	}
	if err := validateFields(&m, d.SourceEvents); err != nil {
		return Memory{}, nil, err
	}
	subjectKind, subjectID, err := parseSubject(m.Subject)
	if err != nil {
		return Memory{}, nil, err
	}
	m.Subject = subjectString(subjectKind, subjectID)

	here := a.String()
	switch a.Kind {
	case audience.KindOwner:
	case audience.KindContact:
		switch {
		case m.Subject == here:
		case subjectKind == audience.KindContact:
			// A contact may tell the agent about someone else; it is kept as their claim.
		default:
			return Memory{}, nil, refuse("in a direct message, a memory can be about the person you are talking to (%s) or about another contact, not %q", here, m.Subject)
		}
		if m.Type == TypeFeedback && m.Subject != here {
			return Memory{}, nil, refuse("a contact can only say how to work with them: feedback from %s must have subject %s", a.ID, here)
		}
	case audience.KindConversation:
		switch {
		case m.Subject == here:
		case subjectKind == audience.KindContact:
		default:
			return Memory{}, nil, refuse("in a group, a memory can be about the group (%s) or about a contact, not %q", here, m.Subject)
		}
		if m.Type == TypeFeedback {
			if m.Subject != here {
				return Memory{}, nil, refuse("feedback saved in a group must have the group as its subject (%s)", here)
			}
			if !a.SpeakerIsOwner {
				return Memory{}, nil, refuse("only the owner can set a rule for this group; follow the request in this conversation without saving it")
			}
		}
	default:
		return Memory{}, nil, refuse("this run has no audience, so it cannot save memories")
	}

	requested := Visibility(strings.TrimSpace(string(d.Visibility)))
	if requested != "" && widthOf(requested) < 0 {
		return Memory{}, nil, refuse("visibility must be private, conversation or public, not %q", requested)
	}
	def, widest := visibilityBounds(a, m.Subject)
	m.Visibility = def
	var notes []string
	if requested != "" {
		m.Visibility = requested
		if widthOf(requested) > widthOf(widest) {
			m.Visibility = widest
			notes = append(notes, fmt.Sprintf("visibility lowered from %s to %s: that is the widest allowed here", requested, widest))
		}
	}
	return m, notes, nil
}

// visibilityBounds is the default and the widest visibility audience a may give a memory about
// subject.
func visibilityBounds(a audience.Audience, subject string) (Visibility, Visibility) {
	switch a.Kind {
	case audience.KindOwner:
		return VisibilityPrivate, VisibilityPublic
	case audience.KindContact:
		// A contact may make public only what is about them; "conversation" from a direct
		// message would reach the same people as private, plus the subject's own messages.
		if subject == a.String() {
			return VisibilityPrivate, VisibilityPublic
		}
		return VisibilityPrivate, VisibilityPrivate
	case audience.KindConversation:
		return VisibilityConversation, VisibilityConversation
	}
	return VisibilityPrivate, VisibilityPrivate
}

func validateFields(m *Memory, sourceEvents []string) error {
	if !namePattern.MatchString(m.Name) || len(m.Name) > maxNameBytes {
		return refuse("name must be a kebab-case slug of at most %d characters, such as release-notes-delivery", maxNameBytes)
	}
	switch m.Type {
	case TypePerson, TypeFeedback, TypeContext, TypeReference:
	default:
		return refuse("type must be person, feedback, context or reference, not %q", m.Type)
	}
	if m.Description == "" || strings.ContainsAny(m.Description, "\r\n") || utf8.RuneCountInString(m.Description) > maxDescriptionRunes {
		return refuse("description must be one line of at most %d characters", maxDescriptionRunes)
	}
	if m.Body == "" || len(m.Body) > maxBodyBytes {
		return refuse("body must be non-empty and at most %d bytes", maxBodyBytes)
	}
	if len(sourceEvents) > maxSourceEvents {
		return refuse("at most %d source events", maxSourceEvents)
	}
	for _, id := range sourceEvents {
		if id = strings.TrimSpace(id); id != "" {
			m.SourceEvents = append(m.SourceEvents, id)
		}
	}
	return nil
}

// parseSubject reads "owner", "general", "contact:<id>" or "conversation:<key>".
func parseSubject(raw string) (audience.Kind, string, error) {
	if raw == SubjectGeneral {
		return "", SubjectGeneral, nil
	}
	a, err := audience.Parse(raw)
	if err != nil || a.IsZero() {
		return "", "", refuse("subject must be owner, general, contact:<contact id> or conversation:<conversation key>, not %q", raw)
	}
	return a.Kind, a.ID, nil
}

func subjectString(kind audience.Kind, id string) string {
	if kind == "" {
		return SubjectGeneral
	}
	return audience.Audience{Kind: kind, ID: id}.String()
}

// canChange reports whether audience a may replace or forget m: the owner may change anything,
// and any other audience what was learned in it.
func canChange(a audience.Audience, m Memory) bool {
	if a.Kind == audience.KindOwner {
		return true
	}
	return !a.IsZero() && m.LearnedIn == a.String()
}

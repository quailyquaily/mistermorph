package todo

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

type ContactSnapshot struct {
	Contacts     []ContactSnapshotItem `json:"contacts"`
	ReachableIDs []string              `json:"reachable_ids"`
	reachableSet map[string]bool
}

type ContactSnapshotItem struct {
	ContactID    string   `json:"contact_id,omitempty"`
	Name         string   `json:"name"`
	Aliases      []string `json:"aliases,omitempty"`
	ReachableIDs []string `json:"reachable_ids"`
	PreferredID  string   `json:"preferred_id,omitempty"`
}

func LoadContactSnapshot(ctx context.Context, contactsDir string) (ContactSnapshot, error) {
	contactsDir = pathutil.ExpandHomePath(strings.TrimSpace(contactsDir))
	if contactsDir == "" {
		return ContactSnapshot{}, fmt.Errorf("contacts dir is not configured")
	}
	svc := contacts.NewService(contacts.NewFileStore(contactsDir))
	items, err := svc.ListContacts(ctx, contacts.StatusActive)
	if err != nil {
		return ContactSnapshot{}, err
	}
	out := ContactSnapshot{
		Contacts: make([]ContactSnapshotItem, 0, len(items)),
	}
	reachableAll := make([]string, 0, len(items)*2)
	for _, item := range items {
		reachable := contactReachableIDs(item)
		reachableAll = append(reachableAll, reachable...)
		name := chooseContactName(item)
		if name == "" {
			name = strings.TrimSpace(item.ContactID)
		}
		if name == "" {
			name = strings.TrimSpace(item.SubjectID)
		}
		if name == "" {
			name = strings.TrimSpace(item.PeerID)
		}
		if name == "" {
			continue
		}
		aliases := dedupeSortedStrings([]string{
			strings.TrimSpace(item.ContactNickname),
			strings.TrimSpace(item.DisplayName),
			extractTelegramAlias(item.ContactID),
			extractTelegramAlias(item.SubjectID),
		})
		preferred := choosePreferredID(item, reachable)
		out.Contacts = append(out.Contacts, ContactSnapshotItem{
			ContactID:    strings.TrimSpace(item.ContactID),
			Name:         name,
			Aliases:      aliases,
			ReachableIDs: reachable,
			PreferredID:  preferred,
		})
	}
	sort.Slice(out.Contacts, func(i, j int) bool {
		if out.Contacts[i].Name == out.Contacts[j].Name {
			return out.Contacts[i].ContactID < out.Contacts[j].ContactID
		}
		return out.Contacts[i].Name < out.Contacts[j].Name
	})
	out.ReachableIDs = dedupeSortedStrings(reachableAll)
	out.ensureReachableSet()
	return out, nil
}

func (s *ContactSnapshot) HasReachableID(ref string) bool {
	if s == nil {
		return false
	}
	s.ensureReachableSet()
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return false
	}
	return s.reachableSet[ref]
}

func (s *ContactSnapshot) ensureReachableSet() {
	if s == nil || s.reachableSet != nil {
		return
	}
	s.reachableSet = make(map[string]bool, len(s.ReachableIDs)*2)
	for _, raw := range s.ReachableIDs {
		v := strings.TrimSpace(raw)
		if v == "" {
			continue
		}
		s.reachableSet[v] = true
	}
}

func chooseContactName(item contacts.Contact) string {
	for _, raw := range []string{
		item.ContactNickname,
		item.DisplayName,
		extractTelegramAlias(item.ContactID),
		extractTelegramAlias(item.SubjectID),
		item.ContactID,
		item.SubjectID,
	} {
		val := strings.TrimSpace(raw)
		if val != "" {
			return val
		}
	}
	return ""
}

func choosePreferredID(item contacts.Contact, reachable []string) string {
	candidates := []string{
		strings.TrimSpace(item.ContactID),
		strings.TrimSpace(item.SubjectID),
	}
	if p := strings.TrimSpace(item.PeerID); p != "" {
		candidates = append(candidates, "maep:"+p)
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if !isValidReferenceID(candidate) {
			continue
		}
		for _, id := range reachable {
			if id == candidate {
				return id
			}
		}
	}
	if len(reachable) == 0 {
		return ""
	}
	return reachable[0]
}

func contactReachableIDs(item contacts.Contact) []string {
	ids := make([]string, 0, 6)
	appendID := func(v string) {
		v = strings.TrimSpace(v)
		if v == "" {
			return
		}
		if !isValidReferenceID(v) {
			return
		}
		ids = append(ids, v)
	}

	appendID(item.ContactID)
	appendID(item.SubjectID)
	if peer := strings.TrimSpace(item.PeerID); peer != "" {
		appendID("maep:" + peer)
	}
	for _, ep := range item.ChannelEndpoints {
		channel := strings.ToLower(strings.TrimSpace(ep.Channel))
		switch channel {
		case contacts.ChannelTelegram:
			if ep.ChatID != 0 {
				appendID(fmt.Sprintf("tg:id:%d", ep.ChatID))
			}
		case contacts.ChannelMAEP:
			addr := strings.TrimSpace(ep.Address)
			if addr != "" {
				appendID("maep:" + addr)
			}
		}
	}
	return dedupeSortedStrings(ids)
}

func extractTelegramAlias(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "tg:@") {
		return strings.TrimPrefix(raw, "tg:@")
	}
	if strings.HasPrefix(raw, "@") {
		return strings.TrimPrefix(raw, "@")
	}
	return ""
}

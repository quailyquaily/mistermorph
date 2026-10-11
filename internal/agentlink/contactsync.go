package agentlink

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

const (
	defaultInactiveAfter = 24 * time.Hour
	contactSyncInterval  = 10 * time.Minute
)

// ContactSyncOptions configure SyncContacts.
type ContactSyncOptions struct {
	ContactsDir string
	// InactiveAfter is how long an agent may stay unreachable before its contact becomes inactive.
	InactiveAfter time.Duration
	Logger        *slog.Logger
	Now           func() time.Time
}

// peerRecord is what the sync remembers about an agent it has seen.
type peerRecord struct {
	AgentName string    `json:"agent_name,omitempty"`
	LastSeen  time.Time `json:"last_seen"`
	// DeactivatedBySync marks a contact the sync made inactive, so it may reactivate it. A contact
	// a person deactivated stays inactive.
	DeactivatedBySync bool `json:"deactivated_by_sync,omitempty"`
}

type peerRecords struct {
	Peers map[string]*peerRecord `json:"peers"`
}

type contactSync struct {
	node   *Node
	store  *contacts.FileStore
	opts   ContactSyncOptions
	logger *slog.Logger
	path   string

	mu      sync.Mutex
	records peerRecords
}

// SyncContacts keeps an active Agent contact for every agent the node reaches until ctx ends, and
// makes contacts inactive once their agents stay unreachable for opts.InactiveAfter.
func SyncContacts(ctx context.Context, node *Node, opts ContactSyncOptions) {
	if node == nil || strings.TrimSpace(opts.ContactsDir) == "" {
		return
	}
	if opts.InactiveAfter <= 0 {
		opts.InactiveAfter = defaultInactiveAfter
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	s := &contactSync{
		node:   node,
		store:  contacts.NewFileStore(opts.ContactsDir),
		opts:   opts,
		logger: logger.With("component", "agentlink_contacts"),
		path:   filepath.Join(node.dir, "peers.json"),
	}
	if _, err := fsstore.ReadJSON(s.path, &s.records); err != nil {
		s.logger.Warn("agentlink_peers_load_error", "error", err.Error())
	}
	if s.records.Peers == nil {
		s.records.Peers = make(map[string]*peerRecord)
	}
	changes := make(chan []Peer, 1)
	cancel := node.Subscribe(func(peers []Peer) {
		// Keep only the latest list.
		select {
		case <-changes:
		default:
		}
		changes <- peers
	})
	defer cancel()
	ticker := time.NewTicker(contactSyncInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case peers := <-changes:
			s.apply(ctx, peers)
		case <-ticker.C:
			s.apply(ctx, node.Peers())
		}
	}
}

func (s *contactSync) apply(ctx context.Context, peers []Peer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.opts.Now().UTC()
	inactive, err := s.inactiveIDs(ctx)
	if err != nil {
		s.logger.Warn("agentlink_contacts_list_error", "error", err.Error())
		return
	}
	reachable := make(map[string]bool, len(peers))
	for _, peer := range peers {
		reachable[peer.InstanceID] = true
		record := s.records.Peers[peer.InstanceID]
		if record == nil {
			record = &peerRecord{}
			s.records.Peers[peer.InstanceID] = record
		}
		record.LastSeen = now
		if peer.AgentName != "" {
			record.AgentName = peer.AgentName
		}
		if err := s.upsert(ctx, peer.InstanceID, record.AgentName); err != nil {
			s.logger.Warn("agentlink_contact_upsert_error", "instance_id", peer.InstanceID, "error", err.Error())
			continue
		}
		contactID := ContactID(peer.InstanceID)
		if inactive[contactID] && record.DeactivatedBySync {
			if _, err := s.store.SetContactStatus(ctx, contactID, contacts.StatusActive); err != nil {
				s.logger.Warn("agentlink_contact_activate_error", "contact_id", contactID, "error", err.Error())
				continue
			}
			record.DeactivatedBySync = false
		}
	}
	for id, record := range s.records.Peers {
		if reachable[id] || record.DeactivatedBySync || now.Sub(record.LastSeen) < s.opts.InactiveAfter {
			continue
		}
		contactID := ContactID(id)
		if inactive[contactID] {
			continue
		}
		found, err := s.store.SetContactStatus(ctx, contactID, contacts.StatusInactive)
		if err != nil {
			s.logger.Warn("agentlink_contact_deactivate_error", "contact_id", contactID, "error", err.Error())
			continue
		}
		if found {
			record.DeactivatedBySync = true
		}
	}
	if err := fsstore.WriteJSONAtomic(s.path, s.records, fsstore.FileOptions{}); err != nil {
		s.logger.Warn("agentlink_peers_save_error", "error", err.Error())
	}
}

func (s *contactSync) inactiveIDs(ctx context.Context) (map[string]bool, error) {
	list, err := s.store.ListContacts(ctx, contacts.StatusInactive)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(list))
	for _, contact := range list {
		out[strings.TrimSpace(contact.ContactID)] = true
	}
	return out, nil
}

// upsert creates the agent's contact, or refreshes its name, keeping everything else the contact
// already holds.
func (s *contactSync) upsert(ctx context.Context, instanceID, agentName string) error {
	contactID := ContactID(instanceID)
	contact, ok, err := s.store.GetContact(ctx, contactID)
	if err != nil {
		return err
	}
	if ok && contact.Kind == contacts.KindAgent && contact.Channel == contacts.ChannelAgentLink && (agentName == "" || contact.ContactNickname == agentName) {
		return nil
	}
	if !ok {
		contact = contacts.Contact{ContactID: contactID}
	}
	contact.Kind = contacts.KindAgent
	contact.Channel = contacts.ChannelAgentLink
	if agentName != "" {
		contact.ContactNickname = agentName
	}
	return s.store.PutContact(ctx, contact)
}

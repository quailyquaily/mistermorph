package agentlink

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
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

// peerRecord is what the sync remembers about an agent it has seen: an agentlink_peers row.
type peerRecord struct {
	AgentName string    `json:"agent_name,omitempty"`
	LastSeen  time.Time `json:"last_seen"`
}

type contactSync struct {
	node   *Node
	store  *contacts.DBStore
	opts   ContactSyncOptions
	logger *slog.Logger
	db     *agentdb.Lazy

	mu    sync.Mutex
	peers map[string]*peerRecord
}

// SyncContacts keeps an active Agent contact for every agent the node reaches until ctx ends, and
// makes contacts inactive once their agents stay unreachable for opts.InactiveAfter. A contact the
// sync made inactive is marked deactivated_by agentlink_sync, so it is the only kind the sync
// makes active again; a contact a person deactivated stays inactive.
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
	s := newContactSync(node, opts, logger)
	if err := s.load(ctx); err != nil {
		s.logger.Warn("agentlink_peers_load_error", "error", err.Error())
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

func newContactSync(node *Node, opts ContactSyncOptions, logger *slog.Logger) *contactSync {
	return &contactSync{
		node:   node,
		store:  contacts.NewStore(opts.ContactsDir),
		opts:   opts,
		logger: logger.With("component", "agentlink_contacts"),
		db:     agentdb.CachedBeside(opts.ContactsDir),
		peers:  map[string]*peerRecord{},
	}
}

// load reads the peers the sync has seen.
func (s *contactSync) load(ctx context.Context) error {
	db, err := s.db.Get(ctx)
	if err != nil {
		return err
	}
	rows, err := db.QueryContext(ctx, `SELECT instance_id, agent_name, last_seen FROM agentlink_peers`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, name, seen string
		if err := rows.Scan(&id, &name, &seen); err != nil {
			return err
		}
		at, err := agentdb.ParseTime(seen)
		if err != nil {
			return err
		}
		s.peers[id] = &peerRecord{AgentName: name, LastSeen: at.UTC()}
	}
	return rows.Err()
}

// savePeer writes one peer's row; only peers that changed are written.
func (s *contactSync) savePeer(ctx context.Context, id string, record *peerRecord) error {
	db, err := s.db.Get(ctx)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO agentlink_peers (instance_id, agent_name, last_seen) VALUES (?, ?, ?)
		ON CONFLICT (instance_id) DO UPDATE SET agent_name = excluded.agent_name, last_seen = excluded.last_seen`,
		id, record.AgentName, agentdb.FormatTime(record.LastSeen))
	return err
}

func (s *contactSync) apply(ctx context.Context, peers []Peer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.opts.Now().UTC()
	reachable := make(map[string]bool, len(peers))
	for _, peer := range peers {
		reachable[peer.InstanceID] = true
		record := s.peers[peer.InstanceID]
		if record == nil {
			record = &peerRecord{}
			s.peers[peer.InstanceID] = record
		}
		record.LastSeen = now
		if peer.AgentName != "" {
			record.AgentName = peer.AgentName
		}
		if err := s.savePeer(ctx, peer.InstanceID, record); err != nil {
			s.logger.Warn("agentlink_peers_save_error", "instance_id", peer.InstanceID, "error", err.Error())
		}
		if err := s.upsert(ctx, peer.InstanceID, record.AgentName); err != nil {
			s.logger.Warn("agentlink_contact_upsert_error", "instance_id", peer.InstanceID, "error", err.Error())
			continue
		}
		contactID := ContactID(peer.InstanceID)
		status, by, found, err := s.store.ContactStatus(ctx, contactID)
		if err != nil {
			s.logger.Warn("agentlink_contacts_list_error", "error", err.Error())
			continue
		}
		if found && status == contacts.StatusInactive && by == contacts.DeactivatedByAgentLink {
			if _, err := s.store.SetContactStatusBy(ctx, contactID, contacts.StatusActive, ""); err != nil {
				s.logger.Warn("agentlink_contact_activate_error", "contact_id", contactID, "error", err.Error())
			}
		}
	}
	for id, record := range s.peers {
		if reachable[id] || now.Sub(record.LastSeen) < s.opts.InactiveAfter {
			continue
		}
		contactID := ContactID(id)
		status, _, found, err := s.store.ContactStatus(ctx, contactID)
		if err != nil {
			s.logger.Warn("agentlink_contacts_list_error", "error", err.Error())
			continue
		}
		if !found || status != contacts.StatusActive {
			continue
		}
		if _, err := s.store.SetContactStatusBy(ctx, contactID, contacts.StatusInactive, contacts.DeactivatedByAgentLink); err != nil {
			s.logger.Warn("agentlink_contact_deactivate_error", "contact_id", contactID, "error", err.Error())
		}
	}
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

func init() {
	agentdb.Register(agentdb.Importer{Name: "agentlink_peers", Order: 50, Run: importPeers})
}

// legacyPeersFile is agentlink/peers.json, which the sync kept before agent.db.
var legacyPeersFile = filepath.ToSlash(filepath.Join("agentlink", "peers.json"))

// importPeers reads agentlink/peers.json into agentlink_peers. A peer whose contact the sync had
// deactivated (deactivated_by_sync) marks that contact deactivated_by agentlink_sync; it runs after
// the contacts import.
func importPeers(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
	var result agentdb.ImportResult
	raw, err := os.ReadFile(filepath.Join(env.StateDir, filepath.FromSlash(legacyPeersFile)))
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Rename = append(result.Rename, legacyPeersFile)
	var file struct {
		Peers map[string]struct {
			AgentName         string    `json:"agent_name"`
			LastSeen          time.Time `json:"last_seen"`
			DeactivatedBySync bool      `json:"deactivated_by_sync"`
		} `json:"peers"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		result.Rejects = append(result.Rejects, stateimport.Reject{Source: legacyPeersFile, Error: err.Error(), Raw: string(raw)})
		return result, nil
	}
	for id, peer := range file.Peers {
		id = strings.TrimSpace(id)
		if id == "" || peer.LastSeen.IsZero() {
			result.Rejects = append(result.Rejects, stateimport.Reject{Source: legacyPeersFile, Error: "peer without an id or last_seen", Raw: id})
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO agentlink_peers (instance_id, agent_name, last_seen) VALUES (?, ?, ?)`,
			id, strings.TrimSpace(peer.AgentName), agentdb.FormatTime(peer.LastSeen)); err != nil {
			return result, err
		}
		if peer.DeactivatedBySync {
			if _, err := tx.ExecContext(ctx, `UPDATE contacts SET deactivated_by = ? WHERE contact_id = ? AND status = 'inactive'`,
				contacts.DeactivatedByAgentLink, ContactID(id)); err != nil {
				return result, err
			}
		}
	}
	return result, nil
}

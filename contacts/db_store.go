package contacts

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"gopkg.in/yaml.v3"
)

const maxActiveContacts = 150

// Why a contact became inactive, in contacts.deactivated_by. A person's own change is "".
const (
	DeactivatedByAgentLink   = "agentlink_sync"
	DeactivatedByActiveLimit = "active_limit"
)

// DBStore keeps the contacts in agent.db: one contacts row each, and a contact_handles row per
// channel identifier, so a lookup by any of them is an index seek. root is the contacts folder,
// which keeps the avatars; agent.db is in the state folder above it.
type DBStore struct {
	root string
	mu   sync.Mutex
	db   *agentdb.Lazy
}

// NewStore returns the contacts store whose folder (for avatars) is root.
func NewStore(root string) *DBStore {
	store := &DBStore{root: strings.TrimSpace(root)}
	// No folder, no database: "contacts" alone would put agent.db in the working directory.
	store.db = agentdb.CachedBeside(store.root)
	return store
}

func (s *DBStore) rootPath() string {
	root := strings.TrimSpace(s.root)
	if root == "" {
		return "contacts"
	}
	return filepath.Clean(root)
}

func (s *DBStore) handle(ctx context.Context) (*agentdb.DB, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return nil, err
	}
	return s.db.Get(context.WithoutCancel(ctx))
}

// Ensure opens the database (and imports the contacts files of an older version).
func (s *DBStore) Ensure(ctx context.Context) error {
	_, err := s.handle(ctx)
	return err
}

// handleField maps a Contact field to its contact_handles rows.
type handleField struct {
	name string
	get  func(*Contact) []string
	set  func(*Contact, []string) error
}

func one(value string) []string {
	if value = strings.TrimSpace(value); value == "" {
		return nil
	}
	return []string{value}
}

func oneInt(value int64) []string {
	if value == 0 {
		return nil
	}
	return []string{strconv.FormatInt(value, 10)}
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func firstInt(values []string) (int64, error) {
	if len(values) == 0 {
		return 0, nil
	}
	return strconv.ParseInt(values[0], 10, 64)
}

// handleFields are the Contact's channel identifiers, by their field names. A new channel adds a
// field here, not a column.
var handleFields = []handleField{
	{"tg_username", func(c *Contact) []string { return one(c.TGUsername) }, func(c *Contact, v []string) error { c.TGUsername = first(v); return nil }},
	{"tg_user_id", func(c *Contact) []string { return oneInt(c.TGUserID) }, func(c *Contact, v []string) (err error) { c.TGUserID, err = firstInt(v); return }},
	{"tg_private_chat_id", func(c *Contact) []string { return oneInt(c.TGPrivateChatID) }, func(c *Contact, v []string) (err error) { c.TGPrivateChatID, err = firstInt(v); return }},
	{"tg_group_chat_ids", func(c *Contact) []string {
		out := make([]string, 0, len(c.TGGroupChatIDs))
		for _, id := range c.TGGroupChatIDs {
			out = append(out, strconv.FormatInt(id, 10))
		}
		return out
	}, func(c *Contact, v []string) error {
		c.TGGroupChatIDs = nil
		for _, raw := range v {
			id, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				return err
			}
			c.TGGroupChatIDs = append(c.TGGroupChatIDs, id)
		}
		return nil
	}},
	{"line_user_id", func(c *Contact) []string { return one(c.LineUserID) }, func(c *Contact, v []string) error { c.LineUserID = first(v); return nil }},
	{"line_chat_ids", func(c *Contact) []string { return c.LineChatIDs }, func(c *Contact, v []string) error { c.LineChatIDs = v; return nil }},
	{"lark_open_id", func(c *Contact) []string { return one(c.LarkOpenID) }, func(c *Contact, v []string) error { c.LarkOpenID = first(v); return nil }},
	{"lark_chat_ids", func(c *Contact) []string { return c.LarkChatIDs }, func(c *Contact, v []string) error { c.LarkChatIDs = v; return nil }},
	{"mixin_user_id", func(c *Contact) []string { return one(c.MixinUserID) }, func(c *Contact, v []string) error { c.MixinUserID = first(v); return nil }},
	{"mixin_identity_number", func(c *Contact) []string { return one(c.MixinIdentityNumber) }, func(c *Contact, v []string) error { c.MixinIdentityNumber = first(v); return nil }},
	{"mixin_chat_ids", func(c *Contact) []string { return c.MixinChatIDs }, func(c *Contact, v []string) error { c.MixinChatIDs = v; return nil }},
	{"discord_user_id", func(c *Contact) []string { return one(c.DiscordUserID) }, func(c *Contact, v []string) error { c.DiscordUserID = first(v); return nil }},
	{"discord_dm_channel_id", func(c *Contact) []string { return one(c.DiscordDMChannelID) }, func(c *Contact, v []string) error { c.DiscordDMChannelID = first(v); return nil }},
	{"discord_channel_ids", func(c *Contact) []string { return c.DiscordChannelIDs }, func(c *Contact, v []string) error { c.DiscordChannelIDs = v; return nil }},
	{"wechat_user_id", func(c *Contact) []string { return one(c.WeChatUserID) }, func(c *Contact, v []string) error { c.WeChatUserID = first(v); return nil }},
	{"whatsapp_user_id", func(c *Contact) []string { return one(c.WhatsAppUserID) }, func(c *Contact, v []string) error { c.WhatsAppUserID = first(v); return nil }},
	{"bluesky_user_id", func(c *Contact) []string { return one(c.BlueskyUserID) }, func(c *Contact, v []string) error { c.BlueskyUserID = first(v); return nil }},
	{"x_user_id", func(c *Contact) []string { return one(c.XUserID) }, func(c *Contact, v []string) error { c.XUserID = first(v); return nil }},
	{"slack_team_id", func(c *Contact) []string { return one(c.SlackTeamID) }, func(c *Contact, v []string) error { c.SlackTeamID = first(v); return nil }},
	{"slack_user_id", func(c *Contact) []string { return one(c.SlackUserID) }, func(c *Contact, v []string) error { c.SlackUserID = first(v); return nil }},
	{"slack_dm_channel_id", func(c *Contact) []string { return one(c.SlackDMChannelID) }, func(c *Contact, v []string) error { c.SlackDMChannelID = first(v); return nil }},
	{"slack_channel_ids", func(c *Contact) []string { return c.SlackChannelIDs }, func(c *Contact, v []string) error { c.SlackChannelIDs = v; return nil }},
}

// HandleFieldNames lists the contact fields kept as handles.
func HandleFieldNames() []string {
	out := make([]string, 0, len(handleFields))
	for _, field := range handleFields {
		out = append(out, field.name)
	}
	return out
}

func handleFieldByName(name string) (handleField, bool) {
	for _, field := range handleFields {
		if field.name == name {
			return field, true
		}
	}
	return handleField{}, false
}

// canonicalContact is the contact as the store keeps it: the same as writing it to the contacts
// file and reading it back did (identifiers normalized, the channel and ids a contact_id implies
// filled in, times to the second).
func canonicalContact(contact Contact) (Contact, error) {
	contact = normalizeContact(contact, time.Now().UTC())
	profile, heading := profileSectionFromContact(contact)
	out, err := contactFromProfileSection(heading, profile)
	if err != nil {
		return Contact{}, err
	}
	out.Owner = contact.Owner
	out.Paired = contact.Paired
	out.legacy = legacyProfile{}
	return out, nil
}

type contactRow struct {
	contact       Contact
	status        Status
	deactivatedBy string
	createdAt     string
}

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

const contactColumns = `contact_id, status, kind, channel, nickname, paired, owner, deactivated_by, cooldown_until,
	last_interaction_at, created_at`

func scanContactRow(scan func(...any) error) (contactRow, error) {
	var row contactRow
	var status, kind string
	var paired, owner int
	var cooldown, interaction sql.NullString
	if err := scan(&row.contact.ContactID, &status, &kind, &row.contact.Channel, &row.contact.ContactNickname, &paired, &owner,
		&row.deactivatedBy, &cooldown, &interaction, &row.createdAt); err != nil {
		return contactRow{}, err
	}
	row.status = Status(status)
	row.contact.Kind = Kind(kind)
	row.contact.Paired = paired != 0
	row.contact.Owner = owner != 0
	for _, pair := range []struct {
		raw sql.NullString
		dst **time.Time
	}{{cooldown, &row.contact.CooldownUntil}, {interaction, &row.contact.LastInteractionAt}} {
		if pair.raw.Valid && pair.raw.String != "" {
			ts, err := agentdb.ParseTime(pair.raw.String)
			if err != nil {
				return contactRow{}, err
			}
			ts = ts.UTC()
			*pair.dst = &ts
		}
	}
	return row, nil
}

// loadContacts reads the contacts the WHERE clause selects, with their handles, ordered by id.
// It takes a transaction because the contacts and their handles are two queries: outside one, a
// write between them would pair one save's contact with another's handles.
func loadContacts(ctx context.Context, q *sql.Tx, where string, args ...any) ([]contactRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+contactColumns+` FROM contacts `+where+` ORDER BY contact_id`, args...)
	if err != nil {
		return nil, err
	}
	var out []contactRow
	index := map[string]int{}
	for rows.Next() {
		row, err := scanContactRow(rows.Scan)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		index[row.contact.ContactID] = len(out)
		out = append(out, row)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	handleQuery := `SELECT contact_id, field, value FROM contact_handles ORDER BY contact_id, field, position, value`
	var handleArgs []any
	if len(out) == 1 {
		handleQuery = `SELECT contact_id, field, value FROM contact_handles WHERE contact_id = ? ORDER BY field, position, value`
		handleArgs = []any{out[0].contact.ContactID}
	}
	hrows, err := q.QueryContext(ctx, handleQuery, handleArgs...)
	if err != nil {
		return nil, err
	}
	values := map[string]map[string][]string{}
	for hrows.Next() {
		var id, field, value string
		if err := hrows.Scan(&id, &field, &value); err != nil {
			_ = hrows.Close()
			return nil, err
		}
		if _, ok := index[id]; !ok {
			continue
		}
		if values[id] == nil {
			values[id] = map[string][]string{}
		}
		values[id][field] = append(values[id][field], value)
	}
	if err := hrows.Close(); err != nil {
		return nil, err
	}
	for id, fields := range values {
		row := &out[index[id]]
		for name, list := range fields {
			field, ok := handleFieldByName(name)
			if !ok {
				continue
			}
			if err := field.set(&row.contact, list); err != nil {
				return nil, fmt.Errorf("contact %s %s: %w", id, name, err)
			}
		}
	}
	return out, nil
}

func getContactRow(ctx context.Context, q *sql.Tx, contactID string) (contactRow, bool, error) {
	rows, err := loadContacts(ctx, q, `WHERE contact_id = ?`, strings.TrimSpace(contactID))
	if err != nil || len(rows) == 0 {
		return contactRow{}, false, err
	}
	return rows[0], true, nil
}

// writeContactRow inserts or replaces the contact and its handles.
func writeContactRow(ctx context.Context, q queryer, row contactRow) error {
	c := row.contact
	now := agentdb.Now()
	createdAt := row.createdAt
	if createdAt == "" {
		createdAt = now
	}
	var cooldown, interaction any
	if c.CooldownUntil != nil && !c.CooldownUntil.IsZero() {
		cooldown = agentdb.FormatTime(*c.CooldownUntil)
	}
	if c.LastInteractionAt != nil && !c.LastInteractionAt.IsZero() {
		interaction = agentdb.FormatTime(*c.LastInteractionAt)
	}
	status := normalizeStatus(row.status)
	deactivatedBy := row.deactivatedBy
	if status == StatusActive {
		deactivatedBy = ""
	}
	if _, err := q.ExecContext(ctx, `INSERT INTO contacts (`+contactColumns+`, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (contact_id) DO UPDATE SET status = excluded.status, kind = excluded.kind, channel = excluded.channel,
		nickname = excluded.nickname, paired = excluded.paired, owner = excluded.owner, deactivated_by = excluded.deactivated_by,
		cooldown_until = excluded.cooldown_until, last_interaction_at = excluded.last_interaction_at,
		updated_at = excluded.updated_at`,
		c.ContactID, string(status), string(normalizeKind(c.Kind)), strings.TrimSpace(c.Channel), c.ContactNickname,
		agentdb.Bool(c.Paired), agentdb.Bool(c.Owner), deactivatedBy, cooldown, interaction, createdAt, now); err != nil {
		return fmt.Errorf("save contact %s: %w", c.ContactID, err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM contact_handles WHERE contact_id = ?`, c.ContactID); err != nil {
		return err
	}
	for _, field := range handleFields {
		for i, value := range field.get(&c) {
			if value = strings.TrimSpace(value); value == "" {
				continue
			}
			if _, err := q.ExecContext(ctx, `INSERT OR IGNORE INTO contact_handles (contact_id, field, value, position) VALUES (?, ?, ?, ?)`,
				c.ContactID, field.name, value, i); err != nil {
				return err
			}
		}
	}
	return nil
}

// enforceActiveLimit moves the active contacts with the oldest last interaction past the limit
// to inactive, marked active_limit.
func enforceActiveLimit(ctx context.Context, q queryer) error {
	var active int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM contacts WHERE status = 'active'`).Scan(&active); err != nil {
		return err
	}
	if active <= maxActiveContacts {
		return nil
	}
	_, err := q.ExecContext(ctx, `UPDATE contacts SET status = 'inactive', deactivated_by = ?, updated_at = ?
		WHERE contact_id IN (SELECT contact_id FROM contacts WHERE status = 'active'
		ORDER BY (last_interaction_at IS NULL), last_interaction_at DESC, contact_id LIMIT -1 OFFSET ?)`,
		DeactivatedByActiveLimit, agentdb.Now(), maxActiveContacts)
	return err
}

func (s *DBStore) inTx(ctx context.Context, fn func(context.Context, *sql.Tx) error) error {
	db, err := s.handle(ctx)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(context.WithoutCancel(ctx), nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}

// readContacts runs loadContacts in a read-only transaction: one snapshot of agent.db, taken
// without the write lock.
func (s *DBStore) readContacts(ctx context.Context, where string, args ...any) ([]contactRow, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := loadContacts(ctx, tx, where, args...)
	if err != nil {
		return nil, err
	}
	return rows, tx.Commit()
}

func (s *DBStore) readContact(ctx context.Context, contactID string) (contactRow, bool, error) {
	rows, err := s.readContacts(ctx, `WHERE contact_id = ?`, strings.TrimSpace(contactID))
	if err != nil || len(rows) == 0 {
		return contactRow{}, false, err
	}
	return rows[0], true, nil
}

func (s *DBStore) GetContact(ctx context.Context, contactID string) (Contact, bool, error) {
	row, ok, err := s.readContact(ctx, contactID)
	return row.contact, ok, err
}

// ContactStatus returns the contact's status and why it became inactive ("" when a person made
// it so, or when it is active).
func (s *DBStore) ContactStatus(ctx context.Context, contactID string) (Status, string, bool, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return "", "", false, err
	}
	var status, by string
	err = db.QueryRowContext(ctx, `SELECT status, deactivated_by FROM contacts WHERE contact_id = ?`, strings.TrimSpace(contactID)).Scan(&status, &by)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return Status(status), by, true, nil
}

// PutContact records a contact seen in a chat. A paired contact stays paired, the owner flag and
// the status stay as stored (an inactive contact becomes active again only when it is paired),
// and a new contact is active. Going over the active limit moves the longest-quiet active
// contacts to inactive, in the same transaction.
func (s *DBStore) PutContact(ctx context.Context, contact Contact) error {
	contact, err := canonicalContact(contact)
	if err != nil {
		return err
	}
	if contact.ContactID == "" {
		return fmt.Errorf("contact_id is required")
	}
	return s.inTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		stored, ok, err := getContactRow(ctx, tx, contact.ContactID)
		if err != nil {
			return err
		}
		row := contactRow{contact: contact, status: StatusActive}
		row.contact.Owner = false
		if ok {
			if stored.contact.Paired {
				row.contact.Paired = true
			}
			row.contact.Owner = stored.contact.Owner
			row.createdAt = stored.createdAt
			if stored.status == StatusInactive && !row.contact.Paired {
				row.status = StatusInactive
				row.deactivatedBy = stored.deactivatedBy
			}
		}
		if err := writeContactRow(ctx, tx, row); err != nil {
			return err
		}
		return enforceActiveLimit(ctx, tx)
	})
}

// SetContactStatus moves a contact to the active or inactive list, as a person does. It reports
// false when the contact does not exist.
func (s *DBStore) SetContactStatus(ctx context.Context, contactID string, status Status) (bool, error) {
	return s.SetContactStatusBy(ctx, contactID, status, "")
}

// SetContactStatusBy is SetContactStatus recording who made the contact inactive
// (DeactivatedByAgentLink); activating clears it.
func (s *DBStore) SetContactStatusBy(ctx context.Context, contactID string, status Status, by string) (bool, error) {
	status = normalizeStatus(status)
	if status == StatusActive {
		by = ""
	}
	found := false
	err := s.inTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE contacts SET status = ?, deactivated_by = ?, updated_at = ?
			WHERE contact_id = ? AND status != ?`, string(status), by, agentdb.Now(), strings.TrimSpace(contactID), string(status))
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			found = true
		} else if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM contacts WHERE contact_id = ?)`, strings.TrimSpace(contactID)).Scan(&found); err != nil {
			return err
		}
		if status == StatusActive {
			return enforceActiveLimit(ctx, tx)
		}
		return nil
	})
	return found, err
}

func (s *DBStore) ListContacts(ctx context.Context, status Status) ([]Contact, error) {
	var rows []contactRow
	var err error
	switch strings.ToLower(strings.TrimSpace(string(status))) {
	case string(StatusActive):
		rows, err = s.readContacts(ctx, `WHERE status = 'active'`)
	case string(StatusInactive):
		rows, err = s.readContacts(ctx, `WHERE status = 'inactive'`)
	default:
		rows, err = s.readContacts(ctx, ``)
	}
	if err != nil {
		return nil, err
	}
	out := make([]Contact, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.contact)
	}
	return out, nil
}

// ContactFilter selects contacts for ListContactsFiltered; empty fields select all.
type ContactFilter struct {
	Status  Status
	Kind    Kind
	Channel string
}

// ListedContact is a contact with its status, for listings.
type ListedContact struct {
	Contact
	Status Status `json:"status"`
}

// ListContactsFiltered lists the contacts the filter selects, by id.
func (s *DBStore) ListContactsFiltered(ctx context.Context, filter ContactFilter) ([]ListedContact, error) {
	var conds []string
	var args []any
	if v := strings.ToLower(strings.TrimSpace(string(filter.Status))); v != "" {
		conds = append(conds, "status = ?")
		args = append(args, v)
	}
	if v := strings.ToLower(strings.TrimSpace(string(filter.Kind))); v != "" {
		conds = append(conds, "kind = ?")
		args = append(args, v)
	}
	if v := strings.ToLower(strings.TrimSpace(filter.Channel)); v != "" {
		conds = append(conds, "channel = ?")
		args = append(args, v)
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	rows, err := s.readContacts(ctx, where, args...)
	if err != nil {
		return nil, err
	}
	out := make([]ListedContact, 0, len(rows))
	for _, row := range rows {
		out = append(out, ListedContact{Contact: row.contact, Status: row.status})
	}
	return out, nil
}

// HasActiveAgent reports whether any active contact is an agent.
func (s *DBStore) HasActiveAgent(ctx context.Context) (bool, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return false, err
	}
	var found bool
	err = db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM contacts WHERE status = 'active' AND kind = 'agent')`).Scan(&found)
	return found, err
}

// FindContactsByHandle lists the contacts with value in the handle field (tg_user_id,
// slack_channel_ids, ...). A group chat id can find several. tg_username matches without case.
func (s *DBStore) FindContactsByHandle(ctx context.Context, field, value string) ([]Contact, error) {
	field, value = strings.TrimSpace(field), strings.TrimSpace(value)
	if _, ok := handleFieldByName(field); !ok {
		return nil, fmt.Errorf("unknown contact handle field: %s", field)
	}
	if value == "" {
		return nil, nil
	}
	match := `value = ?`
	if field == "tg_username" {
		match = `value = ? COLLATE NOCASE`
	}
	rows, err := s.readContacts(ctx, `WHERE contact_id IN (SELECT contact_id FROM contact_handles WHERE field = ? AND `+match+`)`, field, value)
	if err != nil {
		return nil, err
	}
	out := make([]Contact, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.contact)
	}
	return out, nil
}

// ContactYAMLBlock is one contact as the per-contact YAML editor shows it.
type ContactYAMLBlock struct {
	ContactID string
	Status    Status
	Heading   string
	YAML      string
}

func contactYAMLBlock(row contactRow) (ContactYAMLBlock, error) {
	profile, heading := profileSectionFromContact(row.contact)
	raw, err := yaml.Marshal(profile)
	if err != nil {
		return ContactYAMLBlock{}, err
	}
	if heading == "" {
		heading = row.contact.ContactID
	}
	return ContactYAMLBlock{
		ContactID: row.contact.ContactID,
		Status:    row.status,
		Heading:   heading,
		YAML:      strings.TrimRight(string(raw), "\n"),
	}, nil
}

// GetContactYAML renders one contact as the YAML block the contacts file had for it.
func (s *DBStore) GetContactYAML(ctx context.Context, contactID string) (ContactYAMLBlock, bool, error) {
	row, ok, err := s.readContact(ctx, contactID)
	if err != nil || !ok {
		return ContactYAMLBlock{}, ok, err
	}
	block, err := contactYAMLBlock(row)
	return block, true, err
}

// PutContactYAML replaces an existing contact with the one its edited YAML describes, owner and
// paired included; its status stays. The contact_id cannot change.
func (s *DBStore) PutContactYAML(ctx context.Context, contactID string, rawYAML string) (ContactYAMLBlock, error) {
	normalizedYAML := strings.Trim(strings.ReplaceAll(rawYAML, "\r\n", "\n"), "\n")
	if normalizedYAML == "" {
		return ContactYAMLBlock{}, fmt.Errorf("yaml is required")
	}
	var block ContactYAMLBlock
	err := s.inTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		stored, ok, err := getContactRow(ctx, tx, contactID)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("contact not found: %s", strings.TrimSpace(contactID))
		}
		_, contact, err := validateContactYAMLBlock(normalizedYAML, contactID, stored.contact.ContactNickname)
		if err != nil {
			return err
		}
		owner, paired := contact.Owner, contact.Paired
		contact, err = canonicalContact(contact)
		if err != nil {
			return err
		}
		contact.Owner, contact.Paired = owner, paired
		row := contactRow{contact: contact, status: stored.status, deactivatedBy: stored.deactivatedBy, createdAt: stored.createdAt}
		if err := writeContactRow(ctx, tx, row); err != nil {
			return err
		}
		block, err = contactYAMLBlock(row)
		return err
	})
	return block, err
}

// DeleteContactYAML deletes a contact, with its handles and avatar, and returns what it was.
func (s *DBStore) DeleteContactYAML(ctx context.Context, contactID string) (ContactYAMLBlock, bool, error) {
	var block ContactYAMLBlock
	deleted := false
	err := s.inTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		stored, ok, err := getContactRow(ctx, tx, contactID)
		if err != nil || !ok {
			return err
		}
		block, err = contactYAMLBlock(stored)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM contacts WHERE contact_id = ?`, stored.contact.ContactID); err != nil {
			return err
		}
		deleted = true
		return nil
	})
	if err != nil {
		return ContactYAMLBlock{}, false, err
	}
	if deleted {
		_ = os.Remove(s.contactAvatarPath(contactID))
	}
	return block, deleted, nil
}

// SetOwner marks or unmarks a contact as the owner's. The owner sets it from the Console.
func (s *DBStore) SetOwner(ctx context.Context, contactID string, owner bool) (ContactYAMLBlock, bool, error) {
	var block ContactYAMLBlock
	found := false
	err := s.inTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE contacts SET owner = ?, updated_at = ? WHERE contact_id = ?`,
			agentdb.Bool(owner), agentdb.Now(), strings.TrimSpace(contactID))
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		found = true
		stored, _, err := getContactRow(ctx, tx, contactID)
		if err != nil {
			return err
		}
		block, err = contactYAMLBlock(stored)
		return err
	})
	return block, found, err
}

func (s *DBStore) GetBusInboxRecord(ctx context.Context, channel string, platformMessageID string) (BusInboxRecord, bool, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return BusInboxRecord{}, false, err
	}
	channel, err = normalizeBusChannel(channel)
	if err != nil {
		return BusInboxRecord{}, false, err
	}
	var record BusInboxRecord
	var seenAt string
	err = db.QueryRowContext(ctx, `SELECT channel, platform_message_id, conversation_key, seen_at FROM contact_bus_inbox
		WHERE channel = ? AND platform_message_id = ?`, channel, strings.TrimSpace(platformMessageID)).
		Scan(&record.Channel, &record.PlatformMessageID, &record.ConversationKey, &seenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return BusInboxRecord{}, false, nil
	}
	if err != nil {
		return BusInboxRecord{}, false, err
	}
	if record.SeenAt, err = agentdb.ParseTime(seenAt); err != nil {
		return BusInboxRecord{}, false, err
	}
	record.SeenAt = record.SeenAt.UTC()
	return record, true, nil
}

func (s *DBStore) PutBusInboxRecord(ctx context.Context, record BusInboxRecord) error {
	normalized, err := normalizeBusInboxRecord(record)
	if err != nil {
		return err
	}
	db, err := s.handle(ctx)
	if err != nil {
		return err
	}
	return putBusInboxRecord(ctx, db, normalized)
}

func putBusInboxRecord(ctx context.Context, q queryer, record BusInboxRecord) error {
	_, err := q.ExecContext(ctx, `INSERT INTO contact_bus_inbox (channel, platform_message_id, conversation_key, seen_at)
		VALUES (?, ?, ?, ?) ON CONFLICT (channel, platform_message_id) DO UPDATE SET
		conversation_key = excluded.conversation_key, seen_at = excluded.seen_at`,
		record.Channel, record.PlatformMessageID, record.ConversationKey, agentdb.FormatTimePrecise(record.SeenAt))
	return err
}

func (s *DBStore) GetBusOutboxRecord(ctx context.Context, channel string, idempotencyKey string) (BusOutboxRecord, bool, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return BusOutboxRecord{}, false, err
	}
	channel, err = normalizeBusChannel(channel)
	if err != nil {
		return BusOutboxRecord{}, false, err
	}
	var r BusOutboxRecord
	var payload []byte
	var file, lastAttempt, sent sql.NullString
	var status, createdAt, updatedAt string
	var accepted, deduped int
	err = db.QueryRowContext(ctx, `SELECT channel, idempotency_key, contact_id, peer_id, item_id, content_type, payload, file,
		status, attempts, accepted, deduped, last_error, created_at, updated_at, last_attempt_at, sent_at
		FROM contact_bus_outbox WHERE channel = ? AND idempotency_key = ?`, channel, strings.TrimSpace(idempotencyKey)).
		Scan(&r.Channel, &r.IdempotencyKey, &r.ContactID, &r.PeerID, &r.ItemID, &r.ContentType, &payload, &file, &status,
			&r.Attempts, &accepted, &deduped, &r.LastError, &createdAt, &updatedAt, &lastAttempt, &sent)
	if errors.Is(err, sql.ErrNoRows) {
		return BusOutboxRecord{}, false, nil
	}
	if err != nil {
		return BusOutboxRecord{}, false, err
	}
	r.Status = BusDeliveryStatus(status)
	r.Accepted, r.Deduped = accepted != 0, deduped != 0
	if len(payload) > 0 {
		r.PayloadBase64 = base64.RawURLEncoding.EncodeToString(payload)
	}
	if file.Valid && file.String != "" {
		r.File = &ShareFile{}
		if err := json.Unmarshal([]byte(file.String), r.File); err != nil {
			return BusOutboxRecord{}, false, fmt.Errorf("outbox file: %w", err)
		}
	}
	if r.CreatedAt, err = agentdb.ParseTime(createdAt); err != nil {
		return BusOutboxRecord{}, false, err
	}
	if r.UpdatedAt, err = agentdb.ParseTime(updatedAt); err != nil {
		return BusOutboxRecord{}, false, err
	}
	r.CreatedAt, r.UpdatedAt = r.CreatedAt.UTC(), r.UpdatedAt.UTC()
	for _, pair := range []struct {
		raw sql.NullString
		dst **time.Time
	}{{lastAttempt, &r.LastAttemptAt}, {sent, &r.SentAt}} {
		if pair.raw.Valid && pair.raw.String != "" {
			ts, err := agentdb.ParseTime(pair.raw.String)
			if err != nil {
				return BusOutboxRecord{}, false, err
			}
			ts = ts.UTC()
			*pair.dst = &ts
		}
	}
	return r, true, nil
}

func (s *DBStore) PutBusOutboxRecord(ctx context.Context, record BusOutboxRecord) error {
	normalized, err := normalizeBusOutboxRecord(record)
	if err != nil {
		return err
	}
	db, err := s.handle(ctx)
	if err != nil {
		return err
	}
	return putBusOutboxRecord(ctx, db, normalized)
}

// putBusOutboxRecord upserts the record; a record already there keeps its created_at.
func putBusOutboxRecord(ctx context.Context, q queryer, r BusOutboxRecord) error {
	var payload any
	if r.PayloadBase64 != "" {
		raw, err := decodePayload(r.PayloadBase64)
		if err != nil {
			return fmt.Errorf("outbox payload_base64: %w", err)
		}
		payload = raw
	}
	var file any
	if r.File != nil {
		data, err := json.Marshal(r.File)
		if err != nil {
			return err
		}
		file = string(data)
	}
	var lastAttempt, sent any
	if r.LastAttemptAt != nil {
		lastAttempt = agentdb.FormatTimePrecise(*r.LastAttemptAt)
	}
	if r.SentAt != nil {
		sent = agentdb.FormatTimePrecise(*r.SentAt)
	}
	_, err := q.ExecContext(ctx, `INSERT INTO contact_bus_outbox (channel, idempotency_key, contact_id, peer_id, item_id,
		content_type, payload, file, status, attempts, accepted, deduped, last_error, created_at, updated_at, last_attempt_at, sent_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (channel, idempotency_key) DO UPDATE SET contact_id = excluded.contact_id, peer_id = excluded.peer_id,
		item_id = excluded.item_id, content_type = excluded.content_type, payload = excluded.payload, file = excluded.file,
		status = excluded.status, attempts = excluded.attempts, accepted = excluded.accepted, deduped = excluded.deduped,
		last_error = excluded.last_error, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at,
		sent_at = excluded.sent_at`,
		r.Channel, r.IdempotencyKey, r.ContactID, r.PeerID, r.ItemID, r.ContentType, payload, file, string(r.Status),
		r.Attempts, agentdb.Bool(r.Accepted), agentdb.Bool(r.Deduped), r.LastError, agentdb.FormatTimePrecise(r.CreatedAt),
		agentdb.FormatTimePrecise(r.UpdatedAt), lastAttempt, sent)
	return err
}

// sortedContactIDs lists ids in order, for errors that name several contacts.
func sortedContactIDs(items []Contact) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, strings.TrimSpace(item.ContactID))
	}
	sort.Strings(ids)
	return ids
}

// decodePayload reads payload_base64: unpadded base64url, as the senders write it, or an older
// record's other base64 alphabets.
func decodePayload(raw string) ([]byte, error) {
	var firstErr error
	for _, enc := range []*base64.Encoding{base64.RawURLEncoding, base64.URLEncoding, base64.StdEncoding, base64.RawStdEncoding} {
		out, err := enc.DecodeString(raw)
		if err == nil {
			return out, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

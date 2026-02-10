package contacts

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	busInboxFileVersion  = 1
	busOutboxFileVersion = 1
)

type busInboxFile struct {
	Version int              `json:"version"`
	Records []BusInboxRecord `json:"records"`
}

type busOutboxFile struct {
	Version int               `json:"version"`
	Records []BusOutboxRecord `json:"records"`
}

type FileStore struct {
	root string
	mu   sync.Mutex
}

func NewFileStore(root string) *FileStore {
	return &FileStore{root: strings.TrimSpace(root)}
}

func (s *FileStore) Ensure(ctx context.Context) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return ensureDir(s.rootPath(), 0o700)
}

func (s *FileStore) GetContact(ctx context.Context, contactID string) (Contact, bool, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return Contact{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	active, err := s.loadContactsMarkdownLocked(s.activeContactsPath(), StatusActive)
	if err != nil {
		return Contact{}, false, err
	}
	contactID = strings.TrimSpace(contactID)
	for _, item := range active {
		if strings.TrimSpace(item.ContactID) == contactID {
			return item, true, nil
		}
	}

	inactive, err := s.loadContactsMarkdownLocked(s.inactiveContactsPath(), StatusInactive)
	if err != nil {
		return Contact{}, false, err
	}
	for _, item := range inactive {
		if strings.TrimSpace(item.ContactID) == contactID {
			return item, true, nil
		}
	}
	return Contact{}, false, nil
}

func (s *FileStore) PutContact(ctx context.Context, contact Contact) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.withStateLock(ctx, func() error {
		now := time.Now().UTC()
		contact = normalizeContact(contact, now)

		active, err := s.loadContactsMarkdownLocked(s.activeContactsPath(), StatusActive)
		if err != nil {
			return err
		}
		inactive, err := s.loadContactsMarkdownLocked(s.inactiveContactsPath(), StatusInactive)
		if err != nil {
			return err
		}

		active = removeContactByID(active, contact.ContactID)
		inactive = removeContactByID(inactive, contact.ContactID)

		switch contact.Status {
		case StatusInactive:
			inactive = append(inactive, contact)
		default:
			contact.Status = StatusActive
			active = append(active, contact)
		}

		if err := s.saveContactsMarkdownLocked(s.activeContactsPath(), "Active Contacts", StatusActive, active); err != nil {
			return err
		}
		if err := s.saveContactsMarkdownLocked(s.inactiveContactsPath(), "Inactive Contacts", StatusInactive, inactive); err != nil {
			return err
		}
		return nil
	})
}

func (s *FileStore) ListContacts(ctx context.Context, status Status) ([]Contact, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	status = normalizeStatus(status)
	switch status {
	case StatusActive:
		return s.loadContactsMarkdownLocked(s.activeContactsPath(), StatusActive)
	case StatusInactive:
		return s.loadContactsMarkdownLocked(s.inactiveContactsPath(), StatusInactive)
	default:
		active, err := s.loadContactsMarkdownLocked(s.activeContactsPath(), StatusActive)
		if err != nil {
			return nil, err
		}
		inactive, err := s.loadContactsMarkdownLocked(s.inactiveContactsPath(), StatusInactive)
		if err != nil {
			return nil, err
		}
		out := make([]Contact, 0, len(active)+len(inactive))
		out = append(out, active...)
		out = append(out, inactive...)
		sort.Slice(out, func(i, j int) bool {
			if out[i].Status != out[j].Status {
				return out[i].Status < out[j].Status
			}
			return strings.TrimSpace(out[i].ContactID) < strings.TrimSpace(out[j].ContactID)
		})
		return out, nil
	}
}

func (s *FileStore) GetBusInboxRecord(ctx context.Context, channel string, platformMessageID string) (BusInboxRecord, bool, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return BusInboxRecord{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadBusInboxLocked()
	if err != nil {
		return BusInboxRecord{}, false, err
	}
	key, err := busInboxRecordKey(channel, platformMessageID)
	if err != nil {
		return BusInboxRecord{}, false, err
	}
	for _, item := range records {
		itemKey, keyErr := busInboxRecordKey(item.Channel, item.PlatformMessageID)
		if keyErr != nil {
			return BusInboxRecord{}, false, keyErr
		}
		if itemKey == key {
			return item, true, nil
		}
	}
	return BusInboxRecord{}, false, nil
}

func (s *FileStore) PutBusInboxRecord(ctx context.Context, record BusInboxRecord) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.withStateLock(ctx, func() error {
		records, err := s.loadBusInboxLocked()
		if err != nil {
			return err
		}
		normalized, err := normalizeBusInboxRecord(record)
		if err != nil {
			return err
		}
		key, err := busInboxRecordKey(normalized.Channel, normalized.PlatformMessageID)
		if err != nil {
			return err
		}
		replaced := false
		for i := range records {
			itemKey, keyErr := busInboxRecordKey(records[i].Channel, records[i].PlatformMessageID)
			if keyErr != nil {
				return keyErr
			}
			if itemKey != key {
				continue
			}
			records[i] = normalized
			replaced = true
			break
		}
		if !replaced {
			records = append(records, normalized)
		}
		return s.saveBusInboxLocked(records)
	})
}

func (s *FileStore) GetBusOutboxRecord(ctx context.Context, channel string, idempotencyKey string) (BusOutboxRecord, bool, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return BusOutboxRecord{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadBusOutboxLocked()
	if err != nil {
		return BusOutboxRecord{}, false, err
	}
	key, err := busOutboxRecordKey(channel, idempotencyKey)
	if err != nil {
		return BusOutboxRecord{}, false, err
	}
	for _, item := range records {
		itemKey, keyErr := busOutboxRecordKey(item.Channel, item.IdempotencyKey)
		if keyErr != nil {
			return BusOutboxRecord{}, false, keyErr
		}
		if itemKey == key {
			return item, true, nil
		}
	}
	return BusOutboxRecord{}, false, nil
}

func (s *FileStore) PutBusOutboxRecord(ctx context.Context, record BusOutboxRecord) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.withStateLock(ctx, func() error {
		records, err := s.loadBusOutboxLocked()
		if err != nil {
			return err
		}
		normalized, err := normalizeBusOutboxRecord(record)
		if err != nil {
			return err
		}
		key, err := busOutboxRecordKey(normalized.Channel, normalized.IdempotencyKey)
		if err != nil {
			return err
		}
		replaced := false
		for i := range records {
			itemKey, keyErr := busOutboxRecordKey(records[i].Channel, records[i].IdempotencyKey)
			if keyErr != nil {
				return keyErr
			}
			if itemKey != key {
				continue
			}
			if records[i].CreatedAt.IsZero() {
				records[i].CreatedAt = normalized.CreatedAt
			}
			normalized.CreatedAt = records[i].CreatedAt
			records[i] = normalized
			replaced = true
			break
		}
		if !replaced {
			records = append(records, normalized)
		}
		return s.saveBusOutboxLocked(records)
	})
}

func (s *FileStore) loadContactsMarkdownLocked(path string, status Status) ([]Contact, error) {
	content, exists, err := readText(path)
	if err != nil {
		return nil, fmt.Errorf("read contacts markdown %s: %w", path, err)
	}
	if !exists {
		return []Contact{}, nil
	}
	records, err := parseContactsMarkdown(content, status)
	if err != nil {
		return nil, fmt.Errorf("parse contacts markdown %s: %w", path, err)
	}
	for i := range records {
		records[i] = normalizeContact(records[i], time.Now().UTC())
	}
	sort.Slice(records, func(i, j int) bool {
		return strings.TrimSpace(records[i].ContactID) < strings.TrimSpace(records[j].ContactID)
	})
	return records, nil
}

func (s *FileStore) saveContactsMarkdownLocked(path string, title string, status Status, records []Contact) error {
	rendered, err := renderContactsMarkdown(title, status, records)
	if err != nil {
		return err
	}
	return writeTextAtomic(path, rendered, 0o700, 0o600)
}

func parseContactsMarkdown(content string, status Status) ([]Contact, error) {
	return parseContactsProfileMarkdown(content, status)
}

type contactProfileSection struct {
	ContactID         string   `yaml:"contact_id"`
	Nickname          string   `yaml:"nickname"`
	Kind              string   `yaml:"kind"`
	Channel           string   `yaml:"channel"`
	TGUsername        string   `yaml:"tg_username"`
	PrivateChatID     string   `yaml:"private_chat_id"`
	GroupChatIDs      []string `yaml:"group_chat_ids"`
	MAEPNodeID        string   `yaml:"maep_node_id"`
	MAEPDialAddress   string   `yaml:"maep_dial_address"`
	PersonaBrief      string   `yaml:"persona_brief"`
	TopicPreferences  []string `yaml:"topic_preferences"`
	CooldownUntil     string   `yaml:"cooldown_until"`
	LastInteractionAt string   `yaml:"last_interaction_at"`
}

func parseContactsProfileMarkdown(content string, status Status) ([]Contact, error) {
	clean := stripMarkdownHTMLComments(content)
	scanner := bufio.NewScanner(strings.NewReader(clean))
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)

	out := make([]Contact, 0, 64)
	sectionTitle := ""
	inYAML := false
	yamlLines := make([]string, 0, 32)

	flushProfile := func() error {
		if len(yamlLines) == 0 {
			yamlLines = yamlLines[:0]
			return nil
		}
		var profile contactProfileSection
		if err := yaml.Unmarshal([]byte(strings.Join(yamlLines, "\n")), &profile); err != nil {
			return err
		}
		item, err := contactFromProfileSection(sectionTitle, profile, status)
		if err != nil {
			return err
		}
		out = append(out, item)
		yamlLines = yamlLines[:0]
		return nil
	}

	for scanner.Scan() {
		rawLine := scanner.Text()
		line := strings.TrimSpace(rawLine)

		if !inYAML && strings.HasPrefix(line, "## ") {
			sectionTitle = strings.TrimSpace(strings.TrimPrefix(line, "## "))
			continue
		}

		if !inYAML && strings.HasPrefix(line, "```") {
			lowerFence := strings.ToLower(line)
			if strings.HasPrefix(lowerFence, "```yaml") || strings.HasPrefix(lowerFence, "```yml") {
				inYAML = true
				yamlLines = yamlLines[:0]
			}
			continue
		}

		if inYAML && strings.HasPrefix(line, "```") {
			if err := flushProfile(); err != nil {
				return nil, err
			}
			inYAML = false
			continue
		}

		if inYAML {
			yamlLines = append(yamlLines, rawLine)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if inYAML {
		if err := flushProfile(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func renderContactsMarkdown(title string, status Status, records []Contact) (string, error) {
	status = normalizeStatus(status)
	title = strings.TrimSpace(title)
	if title == "" {
		switch status {
		case StatusInactive:
			title = "Inactive Contacts"
		default:
			title = "Active Contacts"
		}
	}

	items := make([]Contact, 0, len(records))
	for _, item := range records {
		items = append(items, normalizeContact(item, time.Now().UTC()))
	}
	sort.Slice(items, func(i, j int) bool {
		return strings.TrimSpace(items[i].ContactID) < strings.TrimSpace(items[j].ContactID)
	})

	nowRFC3339 := time.Now().UTC().Format(time.RFC3339)
	fm := map[string]string{
		"created_at": nowRFC3339,
		"updated_at": nowRFC3339,
	}
	fmRaw, err := yaml.Marshal(fm)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString(string(fmRaw))
	b.WriteString("---\n\n")
	b.WriteString("# ")
	b.WriteString(title)
	b.WriteString("\n\n")
	b.WriteString("<!-- One contact profile per section, as YAML code block. -->\n\n")

	for _, item := range items {
		profile, heading := profileSectionFromContact(item)
		raw, err := yaml.Marshal(profile)
		if err != nil {
			return "", err
		}
		if heading == "" {
			heading = strings.TrimSpace(item.ContactID)
		}
		if heading == "" {
			heading = "Unnamed Contact"
		}
		b.WriteString("## ")
		b.WriteString(heading)
		b.WriteString("\n\n```yaml\n")
		b.Write(raw)
		b.WriteString("```\n\n")
	}
	return b.String(), nil
}

func stripMarkdownHTMLComments(content string) string {
	out := content
	for {
		start := strings.Index(out, "<!--")
		if start < 0 {
			return out
		}
		end := strings.Index(out[start+4:], "-->")
		if end < 0 {
			return out[:start]
		}
		out = out[:start] + out[start+4+end+3:]
	}
}

func contactFromProfileSection(title string, profile contactProfileSection, status Status) (Contact, error) {
	now := time.Now().UTC()
	contact := Contact{
		ContactID:        strings.TrimSpace(profile.ContactID),
		ContactNickname:  strings.TrimSpace(profile.Nickname),
		Channel:          strings.ToLower(strings.TrimSpace(profile.Channel)),
		TGUsername:       normalizeTelegramUsername(profile.TGUsername),
		MAEPDialAddress:  strings.TrimSpace(profile.MAEPDialAddress),
		PersonaBrief:     strings.TrimSpace(profile.PersonaBrief),
		TopicPreferences: normalizeStringSlice(profile.TopicPreferences),
	}
	if contact.ContactNickname == "" && strings.TrimSpace(profile.ContactID) == "" {
		contact.ContactNickname = strings.TrimSpace(title)
	}
	if status != "" {
		contact.Status = status
	}

	privateChatID, err := parseTelegramChatID(profile.PrivateChatID)
	if err != nil {
		return Contact{}, err
	}
	if privateChatID > 0 {
		contact.PrivateChatID = privateChatID
	}
	groupChatIDs := make([]int64, 0, len(profile.GroupChatIDs))
	for _, raw := range profile.GroupChatIDs {
		id, parseErr := parseTelegramChatID(raw)
		if parseErr != nil {
			return Contact{}, parseErr
		}
		if id != 0 {
			groupChatIDs = append(groupChatIDs, id)
		}
	}
	contact.GroupChatIDs = groupChatIDs

	nodeID, _ := splitMAEPNodeID(profile.MAEPNodeID)
	contact.MAEPNodeID = nodeID

	kindRaw := strings.ToLower(strings.TrimSpace(profile.Kind))
	switch kindRaw {
	case string(KindAgent):
		contact.Kind = KindAgent
	case string(KindHuman):
		contact.Kind = KindHuman
	case "":
		channel := strings.ToLower(strings.TrimSpace(profile.Channel))
		if channel == ChannelMAEP {
			contact.Kind = KindAgent
		} else {
			contact.Kind = KindHuman
		}
	default:
		return Contact{}, fmt.Errorf("invalid contact kind: %s", profile.Kind)
	}

	if profile.CooldownUntil != "" {
		ts, parseErr := parseRFC3339Timestamp(profile.CooldownUntil)
		if parseErr != nil {
			return Contact{}, parseErr
		}
		contact.CooldownUntil = &ts
	}
	if profile.LastInteractionAt != "" {
		ts, parseErr := parseRFC3339Timestamp(profile.LastInteractionAt)
		if parseErr != nil {
			return Contact{}, parseErr
		}
		contact.LastInteractionAt = &ts
	}

	contact = normalizeContact(contact, now)
	if contact.ContactID == "" {
		contact.ContactID = deriveContactID(contact)
	}
	if contact.ContactID == "" {
		contact.ContactID = "contact:" + slugToken(contact.ContactNickname)
	}
	contact = normalizeContact(contact, now)
	return contact, nil
}

func profileSectionFromContact(contact Contact) (contactProfileSection, string) {
	contact = normalizeContact(contact, time.Now().UTC())
	profile := contactProfileSection{
		ContactID:        strings.TrimSpace(contact.ContactID),
		Nickname:         strings.TrimSpace(contact.ContactNickname),
		Kind:             string(normalizeKind(contact.Kind)),
		Channel:          strings.TrimSpace(contact.Channel),
		TGUsername:       normalizeTelegramUsername(contact.TGUsername),
		MAEPNodeID:       strings.TrimSpace(contact.MAEPNodeID),
		MAEPDialAddress:  strings.TrimSpace(contact.MAEPDialAddress),
		PersonaBrief:     strings.TrimSpace(contact.PersonaBrief),
		TopicPreferences: normalizeStringSlice(contact.TopicPreferences),
	}

	if profile.Channel == "" {
		switch {
		case contact.PrivateChatID != 0 || len(contact.GroupChatIDs) > 0 || profile.TGUsername != "":
			profile.Channel = ChannelTelegram
		case profile.MAEPNodeID != "":
			profile.Channel = ChannelMAEP
		default:
			profile.Channel = strings.TrimSpace(string(normalizeKind(contact.Kind)))
		}
	}

	if profile.TGUsername == "" {
		if alias := extractTelegramAlias(profile.ContactID); alias != "" {
			profile.TGUsername = alias
		}
	}
	if contact.PrivateChatID != 0 {
		profile.PrivateChatID = strconv.FormatInt(contact.PrivateChatID, 10)
	}
	if len(contact.GroupChatIDs) > 0 {
		ids := make([]int64, 0, len(contact.GroupChatIDs))
		ids = append(ids, contact.GroupChatIDs...)
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		out := make([]string, 0, len(ids))
		seen := map[string]bool{}
		for _, id := range ids {
			value := strconv.FormatInt(id, 10)
			if seen[value] {
				continue
			}
			seen[value] = true
			out = append(out, value)
		}
		profile.GroupChatIDs = out
	}
	if profile.MAEPNodeID == "" {
		nodeID, _ := splitMAEPNodeID(contact.ContactID)
		profile.MAEPNodeID = nodeID
	}
	if contact.CooldownUntil != nil && !contact.CooldownUntil.IsZero() {
		profile.CooldownUntil = contact.CooldownUntil.UTC().Format(time.RFC3339)
	}
	if contact.LastInteractionAt != nil && !contact.LastInteractionAt.IsZero() {
		profile.LastInteractionAt = contact.LastInteractionAt.UTC().Format(time.RFC3339)
	}

	heading := strings.TrimSpace(contact.ContactNickname)
	if heading == "" {
		heading = strings.TrimSpace(contact.ContactID)
	}
	return profile, heading
}

func parseRFC3339Timestamp(raw string) (time.Time, error) {
	value := strings.TrimSpace(raw)
	ts, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid RFC3339 timestamp %q", raw)
	}
	return ts.UTC(), nil
}

func parseTelegramChatID(raw string) (int64, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, nil
	}
	if strings.HasPrefix(strings.ToLower(value), "tg:") {
		value = strings.TrimSpace(value[len("tg:"):])
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid telegram chat id %q", raw)
	}
	return id, nil
}

func normalizeTelegramUsername(raw string) string {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(value, "@")
	return strings.TrimSpace(value)
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

func splitMAEPNodeID(raw string) (string, string) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", ""
	}
	lower := strings.ToLower(value)
	if strings.Contains(value, ":") && !strings.HasPrefix(lower, "maep:") {
		return "", ""
	}
	if strings.HasPrefix(lower, "maep:") {
		peerID := strings.TrimSpace(value[len("maep:"):])
		if peerID == "" {
			return "", ""
		}
		return "maep:" + peerID, peerID
	}
	return "maep:" + value, value
}

func slugToken(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "unnamed"
	}
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		isLetter := r >= 'a' && r <= 'z'
		isDigit := r >= '0' && r <= '9'
		if isLetter || isDigit {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	token := strings.Trim(b.String(), "-")
	if token == "" {
		return "unnamed"
	}
	return token
}

func removeContactByID(items []Contact, contactID string) []Contact {
	out := items[:0]
	contactID = strings.TrimSpace(contactID)
	for _, item := range items {
		if strings.TrimSpace(item.ContactID) == contactID {
			continue
		}
		out = append(out, item)
	}
	return out
}

func (s *FileStore) loadBusInboxLocked() ([]BusInboxRecord, error) {
	var file busInboxFile
	ok, err := readJSONFileStrict(s.busInboxPath(), &file)
	if err != nil {
		return nil, err
	}
	if !ok {
		return []BusInboxRecord{}, nil
	}
	if file.Version != busInboxFileVersion {
		return nil, fmt.Errorf("unsupported bus inbox file version: %d", file.Version)
	}
	out := make([]BusInboxRecord, 0, len(file.Records))
	for _, item := range file.Records {
		normalized, normalizeErr := normalizeBusInboxRecord(item)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		out = append(out, normalized)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SeenAt.Equal(out[j].SeenAt) {
			iKey, _ := busInboxRecordKey(out[i].Channel, out[i].PlatformMessageID)
			jKey, _ := busInboxRecordKey(out[j].Channel, out[j].PlatformMessageID)
			return iKey < jKey
		}
		return out[i].SeenAt.After(out[j].SeenAt)
	})
	return out, nil
}

func (s *FileStore) saveBusInboxLocked(records []BusInboxRecord) error {
	sort.Slice(records, func(i, j int) bool {
		if records[i].SeenAt.Equal(records[j].SeenAt) {
			iKey, _ := busInboxRecordKey(records[i].Channel, records[i].PlatformMessageID)
			jKey, _ := busInboxRecordKey(records[j].Channel, records[j].PlatformMessageID)
			return iKey < jKey
		}
		return records[i].SeenAt.After(records[j].SeenAt)
	})
	file := busInboxFile{Version: busInboxFileVersion, Records: records}
	return writeJSONFileAtomic(s.busInboxPath(), file)
}

func (s *FileStore) loadBusOutboxLocked() ([]BusOutboxRecord, error) {
	var file busOutboxFile
	ok, err := readJSONFileStrict(s.busOutboxPath(), &file)
	if err != nil {
		return nil, err
	}
	if !ok {
		return []BusOutboxRecord{}, nil
	}
	if file.Version != busOutboxFileVersion {
		return nil, fmt.Errorf("unsupported bus outbox file version: %d", file.Version)
	}
	out := make([]BusOutboxRecord, 0, len(file.Records))
	for _, item := range file.Records {
		normalized, normalizeErr := normalizeBusOutboxRecord(item)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		out = append(out, normalized)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			iKey, _ := busOutboxRecordKey(out[i].Channel, out[i].IdempotencyKey)
			jKey, _ := busOutboxRecordKey(out[j].Channel, out[j].IdempotencyKey)
			return iKey < jKey
		}
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	return out, nil
}

func (s *FileStore) saveBusOutboxLocked(records []BusOutboxRecord) error {
	sort.Slice(records, func(i, j int) bool {
		if records[i].UpdatedAt.Equal(records[j].UpdatedAt) {
			iKey, _ := busOutboxRecordKey(records[i].Channel, records[i].IdempotencyKey)
			jKey, _ := busOutboxRecordKey(records[j].Channel, records[j].IdempotencyKey)
			return iKey < jKey
		}
		return records[i].UpdatedAt.After(records[j].UpdatedAt)
	})
	file := busOutboxFile{Version: busOutboxFileVersion, Records: records}
	return writeJSONFileAtomic(s.busOutboxPath(), file)
}

func (s *FileStore) withStateLock(ctx context.Context, fn func() error) error {
	return s.withLock(ctx, "state.main", fn)
}

func (s *FileStore) withLock(ctx context.Context, key string, fn func() error) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	if strings.TrimSpace(key) == "" || fn == nil {
		return nil
	}
	return fn()
}

func (s *FileStore) rootPath() string {
	root := strings.TrimSpace(s.root)
	if root == "" {
		return "contacts"
	}
	return filepath.Clean(root)
}

func (s *FileStore) activeContactsPath() string {
	return filepath.Join(s.rootPath(), "ACTIVE.md")
}

func (s *FileStore) inactiveContactsPath() string {
	return filepath.Join(s.rootPath(), "INACTIVE.md")
}

func (s *FileStore) busInboxPath() string {
	return filepath.Join(s.rootPath(), "bus_inbox.json")
}

func (s *FileStore) busOutboxPath() string {
	return filepath.Join(s.rootPath(), "bus_outbox.json")
}

func normalizeContact(c Contact, now time.Time) Contact {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	c.ContactID = strings.TrimSpace(c.ContactID)
	c.ContactNickname = strings.TrimSpace(c.ContactNickname)
	c.PersonaBrief = strings.TrimSpace(c.PersonaBrief)
	c.TGUsername = normalizeTelegramUsername(c.TGUsername)
	c.Kind = normalizeKind(c.Kind)
	c.Status = normalizeStatus(c.Status)
	c.Channel = normalizeContactChannel(c.Channel)
	c.GroupChatIDs = normalizeInt64Slice(c.GroupChatIDs)
	if c.PrivateChatID <= 0 {
		c.PrivateChatID = 0
	}
	nodeID, _ := splitMAEPNodeID(c.MAEPNodeID)
	c.MAEPNodeID = nodeID
	c.MAEPDialAddress = strings.TrimSpace(c.MAEPDialAddress)
	c.TopicPreferences = normalizeStringSlice(c.TopicPreferences)
	if len(c.TopicPreferences) == 0 {
		c.TopicPreferences = nil
	}

	if c.CooldownUntil != nil {
		ts := c.CooldownUntil.UTC()
		if ts.IsZero() {
			c.CooldownUntil = nil
		} else {
			c.CooldownUntil = &ts
		}
	}
	if c.LastInteractionAt != nil {
		ts := c.LastInteractionAt.UTC()
		if ts.IsZero() {
			c.LastInteractionAt = nil
		} else {
			c.LastInteractionAt = &ts
		}
	}

	if c.ContactID == "" {
		c.ContactID = deriveContactID(c)
	}
	if c.ContactID == "" {
		c.ContactID = "contact:" + slugToken(c.ContactNickname)
	}

	if c.Channel == "" {
		switch {
		case strings.HasPrefix(strings.ToLower(c.ContactID), "tg:"), c.PrivateChatID != 0, len(c.GroupChatIDs) > 0, c.TGUsername != "":
			c.Channel = ChannelTelegram
		case strings.HasPrefix(strings.ToLower(c.ContactID), "maep:"), c.MAEPNodeID != "", c.MAEPDialAddress != "":
			c.Channel = ChannelMAEP
		}
	}
	if c.Channel == "" {
		if c.Kind == KindHuman {
			c.Channel = ChannelTelegram
		} else {
			c.Channel = ChannelMAEP
		}
	}

	if strings.HasPrefix(strings.ToLower(c.ContactID), "tg:@") && c.TGUsername == "" {
		c.TGUsername = normalizeTelegramUsername(c.ContactID[len("tg:@"):])
	}
	if strings.HasPrefix(strings.ToLower(c.ContactID), "tg:") && c.PrivateChatID == 0 {
		id, err := parseTelegramChatID(c.ContactID[len("tg:"):])
		if err == nil && id > 0 {
			c.PrivateChatID = id
		}
	}
	if strings.HasPrefix(strings.ToLower(c.ContactID), "maep:") && c.MAEPNodeID == "" {
		node, _ := splitMAEPNodeID(c.ContactID)
		c.MAEPNodeID = node
	}

	if c.TGUsername == "" && c.PrivateChatID == 0 && len(c.GroupChatIDs) == 0 && c.Channel == ChannelTelegram {
		if alias := extractTelegramAlias(c.ContactID); alias != "" {
			c.TGUsername = alias
		}
	}

	if c.ContactID == "" {
		c.ContactID = deriveContactID(c)
	}
	return c
}

func normalizeContactChannel(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	switch value {
	case ChannelTelegram, ChannelMAEP, "slack", "discord":
		return value
	default:
		return ""
	}
}

func normalizeKind(kind Kind) Kind {
	switch kind {
	case KindHuman, KindAgent:
		return kind
	default:
		return KindAgent
	}
}

func normalizeStatus(status Status) Status {
	switch status {
	case StatusInactive:
		return StatusInactive
	case StatusActive:
		return StatusActive
	default:
		return StatusActive
	}
}

func normalizeStringSlice(input []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(input))
	for _, raw := range input {
		v := strings.TrimSpace(raw)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

func normalizeInt64Slice(input []int64) []int64 {
	seen := map[int64]bool{}
	out := make([]int64, 0, len(input))
	for _, raw := range input {
		if raw == 0 || seen[raw] {
			continue
		}
		seen[raw] = true
		out = append(out, raw)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	if len(out) == 0 {
		return nil
	}
	return out
}

func clamp(v float64, min float64, max float64) float64 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func busInboxRecordKey(channel string, platformMessageID string) (string, error) {
	normalizedChannel, err := normalizeBusChannel(channel)
	if err != nil {
		return "", err
	}
	normalizedMessageID := strings.TrimSpace(platformMessageID)
	if normalizedMessageID == "" {
		return "", fmt.Errorf("platform_message_id is required")
	}
	return normalizedChannel + ":" + normalizedMessageID, nil
}

func busOutboxRecordKey(channel string, idempotencyKey string) (string, error) {
	normalizedChannel, err := normalizeBusChannel(channel)
	if err != nil {
		return "", err
	}
	normalizedKey := strings.TrimSpace(idempotencyKey)
	if normalizedKey == "" {
		return "", fmt.Errorf("idempotency_key is required")
	}
	return normalizedChannel + ":" + normalizedKey, nil
}

func normalizeBusInboxRecord(record BusInboxRecord) (BusInboxRecord, error) {
	channel, err := normalizeBusChannel(record.Channel)
	if err != nil {
		return BusInboxRecord{}, err
	}
	platformMessageID := strings.TrimSpace(record.PlatformMessageID)
	if platformMessageID == "" {
		return BusInboxRecord{}, fmt.Errorf("platform_message_id is required")
	}
	seenAt := record.SeenAt.UTC()
	if seenAt.IsZero() {
		return BusInboxRecord{}, fmt.Errorf("seen_at is required")
	}
	return BusInboxRecord{
		Channel:           channel,
		PlatformMessageID: platformMessageID,
		ConversationKey:   strings.TrimSpace(record.ConversationKey),
		SeenAt:            seenAt,
	}, nil
}

func normalizeBusOutboxRecord(record BusOutboxRecord) (BusOutboxRecord, error) {
	channel, err := normalizeBusChannel(record.Channel)
	if err != nil {
		return BusOutboxRecord{}, err
	}
	idempotencyKey := strings.TrimSpace(record.IdempotencyKey)
	if idempotencyKey == "" {
		return BusOutboxRecord{}, fmt.Errorf("idempotency_key is required")
	}
	status, err := normalizeBusDeliveryStatus(record.Status)
	if err != nil {
		return BusOutboxRecord{}, err
	}
	if record.Attempts <= 0 {
		return BusOutboxRecord{}, fmt.Errorf("attempts must be > 0")
	}
	createdAt := record.CreatedAt.UTC()
	updatedAt := record.UpdatedAt.UTC()
	if createdAt.IsZero() {
		return BusOutboxRecord{}, fmt.Errorf("created_at is required")
	}
	if updatedAt.IsZero() {
		return BusOutboxRecord{}, fmt.Errorf("updated_at is required")
	}
	if updatedAt.Before(createdAt) {
		return BusOutboxRecord{}, fmt.Errorf("updated_at must be >= created_at")
	}
	normalized := BusOutboxRecord{
		Channel:        channel,
		IdempotencyKey: idempotencyKey,
		ContactID:      strings.TrimSpace(record.ContactID),
		PeerID:         strings.TrimSpace(record.PeerID),
		ItemID:         strings.TrimSpace(record.ItemID),
		Topic:          strings.TrimSpace(record.Topic),
		ContentType:    strings.TrimSpace(record.ContentType),
		PayloadBase64:  strings.TrimSpace(record.PayloadBase64),
		Status:         status,
		Attempts:       record.Attempts,
		Accepted:       record.Accepted,
		Deduped:        record.Deduped,
		LastError:      strings.TrimSpace(record.LastError),
		CreatedAt:      createdAt,
		UpdatedAt:      updatedAt,
	}
	if record.LastAttemptAt != nil {
		ts := record.LastAttemptAt.UTC()
		if ts.IsZero() {
			return BusOutboxRecord{}, fmt.Errorf("last_attempt_at must not be zero")
		}
		normalized.LastAttemptAt = &ts
	}
	if record.SentAt != nil {
		ts := record.SentAt.UTC()
		if ts.IsZero() {
			return BusOutboxRecord{}, fmt.Errorf("sent_at must not be zero")
		}
		normalized.SentAt = &ts
	}
	if normalized.Status == BusDeliveryStatusSent && normalized.SentAt == nil {
		return BusOutboxRecord{}, fmt.Errorf("sent_at is required when status=sent")
	}
	if normalized.Status != BusDeliveryStatusSent && normalized.SentAt != nil {
		return BusOutboxRecord{}, fmt.Errorf("sent_at must be empty when status is not sent")
	}
	if normalized.Status == BusDeliveryStatusFailed && normalized.LastError == "" {
		return BusOutboxRecord{}, fmt.Errorf("last_error is required when status=failed")
	}
	if normalized.Status != BusDeliveryStatusFailed && normalized.LastError != "" {
		return BusOutboxRecord{}, fmt.Errorf("last_error must be empty when status is not failed")
	}
	return normalized, nil
}

func readJSONFileStrict(path string, out any) (bool, error) {
	normalizedPath := filepath.Clean(strings.TrimSpace(path))
	if normalizedPath == "." || normalizedPath == "" {
		return false, fmt.Errorf("path is required")
	}
	data, err := os.ReadFile(normalizedPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("read %s: %w", normalizedPath, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return false, nil
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return false, fmt.Errorf("decode %s: %w", normalizedPath, err)
	}
	var trailing struct{}
	if err := dec.Decode(&trailing); err != io.EOF {
		if err == nil {
			return false, fmt.Errorf("decode %s: trailing data", normalizedPath)
		}
		return false, fmt.Errorf("decode %s: trailing data: %w", normalizedPath, err)
	}
	return true, nil
}

func writeJSONFileAtomic(path string, v any) error {
	return writeJSONAtomic(path, v, 0o700, 0o600)
}

func ensureDir(path string, perm os.FileMode) error {
	normalizedPath := filepath.Clean(strings.TrimSpace(path))
	if normalizedPath == "" {
		return fmt.Errorf("path is required")
	}
	if perm == 0 {
		perm = 0o700
	}
	if err := os.MkdirAll(normalizedPath, perm); err != nil {
		return fmt.Errorf("ensure dir %s: %w", normalizedPath, err)
	}
	return nil
}

func readText(path string) (string, bool, error) {
	normalizedPath := filepath.Clean(strings.TrimSpace(path))
	if normalizedPath == "" {
		return "", false, fmt.Errorf("path is required")
	}
	data, err := os.ReadFile(normalizedPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read text %s: %w", normalizedPath, err)
	}
	return string(data), true, nil
}

func writeTextAtomic(path string, content string, dirPerm os.FileMode, filePerm os.FileMode) error {
	return writeBytesAtomic(path, []byte(content), dirPerm, filePerm)
}

func readJSON(path string, out any) (bool, error) {
	normalizedPath := filepath.Clean(strings.TrimSpace(path))
	if normalizedPath == "" {
		return false, fmt.Errorf("path is required")
	}
	data, err := os.ReadFile(normalizedPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("read json %s: %w", normalizedPath, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return false, nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return false, fmt.Errorf("decode json %s: %w", normalizedPath, err)
	}
	return true, nil
}

func writeJSONAtomic(path string, v any, dirPerm os.FileMode, filePerm os.FileMode) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("encode json %s: %w", strings.TrimSpace(path), err)
	}
	data = append(data, '\n')
	return writeBytesAtomic(path, data, dirPerm, filePerm)
}

func writeBytesAtomic(path string, data []byte, dirPerm os.FileMode, filePerm os.FileMode) error {
	normalizedPath := filepath.Clean(strings.TrimSpace(path))
	if normalizedPath == "" {
		return fmt.Errorf("path is required")
	}
	if dirPerm == 0 {
		dirPerm = 0o700
	}
	if filePerm == 0 {
		filePerm = 0o600
	}
	parentDir := filepath.Dir(normalizedPath)
	if err := ensureDir(parentDir, dirPerm); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(parentDir, filepath.Base(normalizedPath)+".tmp.*")
	if err != nil {
		return fmt.Errorf("create temp for %s: %w", normalizedPath, err)
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}()

	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write temp for %s: %w", normalizedPath, err)
	}
	if err := tmp.Chmod(filePerm); err != nil {
		return fmt.Errorf("chmod temp for %s: %w", normalizedPath, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp for %s: %w", normalizedPath, err)
	}
	if err := os.Rename(tmpPath, normalizedPath); err != nil {
		return fmt.Errorf("rename temp for %s: %w", normalizedPath, err)
	}
	return nil
}

func ensureNotCanceled(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

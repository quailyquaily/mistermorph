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

	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

const (
	candidatesFileVersion  = 1
	sessionsFileVersion    = 1
	busInboxFileVersion    = 1
	busOutboxFileVersion   = 1
	busDeliveryFileVersion = 1
	contactPronounsMaxLen  = 64
	contactTZMaxLen        = 64
	contactPrefMaxLen      = 2000
)

type candidatesFile struct {
	Version int              `json:"version"`
	Records []ShareCandidate `json:"records"`
}

type sessionsFile struct {
	Version int            `json:"version"`
	Records []SessionState `json:"records"`
}

type busInboxFile struct {
	Version int              `json:"version"`
	Records []BusInboxRecord `json:"records"`
}

type busOutboxFile struct {
	Version int               `json:"version"`
	Records []BusOutboxRecord `json:"records"`
}

type busDeliveryFile struct {
	Version int                 `json:"version"`
	Records []BusDeliveryRecord `json:"records"`
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
	return fsstore.EnsureDir(s.rootPath(), 0o700)
}

func (s *FileStore) GetContact(ctx context.Context, contactID string) (Contact, bool, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return Contact{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	active, err := s.loadContactsMarkdownLocked(s.activeContactsPath())
	if err != nil {
		return Contact{}, false, err
	}
	contactID = strings.TrimSpace(contactID)
	for _, item := range active {
		if strings.TrimSpace(item.ContactID) == contactID {
			return item, true, nil
		}
	}

	inactive, err := s.loadContactsMarkdownLocked(s.inactiveContactsPath())
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

		active, err := s.loadContactsMarkdownLocked(s.activeContactsPath())
		if err != nil {
			return err
		}
		inactive, err := s.loadContactsMarkdownLocked(s.inactiveContactsPath())
		if err != nil {
			return err
		}

		createdAt := contact.CreatedAt
		active = removeContactByID(active, contact.ContactID, &createdAt)
		inactive = removeContactByID(inactive, contact.ContactID, &createdAt)
		contact.CreatedAt = createdAt

		switch contact.Status {
		case StatusInactive:
			inactive = append(inactive, contact)
		default:
			contact.Status = StatusActive
			active = append(active, contact)
		}

		if err := s.saveContactsMarkdownLocked(s.activeContactsPath(), "Active Contacts", active); err != nil {
			return err
		}
		if err := s.saveContactsMarkdownLocked(s.inactiveContactsPath(), "Inactive Contacts", inactive); err != nil {
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
		return s.loadContactsMarkdownLocked(s.activeContactsPath())
	case StatusInactive:
		return s.loadContactsMarkdownLocked(s.inactiveContactsPath())
	default:
		active, err := s.loadContactsMarkdownLocked(s.activeContactsPath())
		if err != nil {
			return nil, err
		}
		inactive, err := s.loadContactsMarkdownLocked(s.inactiveContactsPath())
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

func (s *FileStore) GetCandidate(ctx context.Context, itemID string) (ShareCandidate, bool, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return ShareCandidate{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadCandidatesLocked()
	if err != nil {
		return ShareCandidate{}, false, err
	}
	itemID = strings.TrimSpace(itemID)
	for _, item := range records {
		if strings.TrimSpace(item.ItemID) == itemID {
			return item, true, nil
		}
	}
	return ShareCandidate{}, false, nil
}

func (s *FileStore) PutCandidate(ctx context.Context, candidate ShareCandidate) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.withStateLock(ctx, func() error {
		records, err := s.loadCandidatesLocked()
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		candidate = normalizeCandidate(candidate, now)
		replaced := false
		for i := range records {
			if strings.TrimSpace(records[i].ItemID) != candidate.ItemID {
				continue
			}
			if records[i].CreatedAt.IsZero() {
				records[i].CreatedAt = candidate.CreatedAt
			}
			candidate.CreatedAt = records[i].CreatedAt
			records[i] = candidate
			replaced = true
			break
		}
		if !replaced {
			records = append(records, candidate)
		}
		return s.saveCandidatesLocked(records)
	})
}

func (s *FileStore) ListCandidates(ctx context.Context) ([]ShareCandidate, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadCandidatesLocked()
}

func (s *FileStore) GetSessionState(ctx context.Context, sessionID string) (SessionState, bool, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return SessionState{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadSessionsLocked()
	if err != nil {
		return SessionState{}, false, err
	}
	sessionID = strings.TrimSpace(sessionID)
	for _, item := range records {
		if strings.TrimSpace(item.SessionID) == sessionID {
			return item, true, nil
		}
	}
	return SessionState{}, false, nil
}

func (s *FileStore) PutSessionState(ctx context.Context, state SessionState) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.withStateLock(ctx, func() error {
		records, err := s.loadSessionsLocked()
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		state = normalizeSessionState(state, now)
		replaced := false
		for i := range records {
			if strings.TrimSpace(records[i].SessionID) != state.SessionID {
				continue
			}
			if records[i].StartedAt.IsZero() {
				records[i].StartedAt = state.StartedAt
			}
			state.StartedAt = records[i].StartedAt
			records[i] = state
			replaced = true
			break
		}
		if !replaced {
			records = append(records, state)
		}
		return s.saveSessionsLocked(records)
	})
}

func (s *FileStore) ListSessionStates(ctx context.Context) ([]SessionState, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadSessionsLocked()
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

func (s *FileStore) GetBusDeliveryRecord(ctx context.Context, channel string, idempotencyKey string) (BusDeliveryRecord, bool, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return BusDeliveryRecord{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadBusDeliveryLocked()
	if err != nil {
		return BusDeliveryRecord{}, false, err
	}
	key, err := busOutboxRecordKey(channel, idempotencyKey)
	if err != nil {
		return BusDeliveryRecord{}, false, err
	}
	for _, item := range records {
		itemKey, keyErr := busOutboxRecordKey(item.Channel, item.IdempotencyKey)
		if keyErr != nil {
			return BusDeliveryRecord{}, false, keyErr
		}
		if itemKey == key {
			return item, true, nil
		}
	}
	return BusDeliveryRecord{}, false, nil
}

func (s *FileStore) PutBusDeliveryRecord(ctx context.Context, record BusDeliveryRecord) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.withStateLock(ctx, func() error {
		records, err := s.loadBusDeliveryLocked()
		if err != nil {
			return err
		}
		normalized, err := normalizeBusDeliveryRecord(record)
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
		return s.saveBusDeliveryLocked(records)
	})
}

func (s *FileStore) AppendAuditEvent(ctx context.Context, event AuditEvent) error {
	if err := ensureNotCanceled(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	event = normalizeAuditEvent(event, time.Now().UTC())
	return s.withAuditLock(ctx, func() error {
		writer, err := fsstore.NewJSONLWriter(s.auditPathJSONL(), fsstore.JSONLOptions{
			DirPerm:        0o700,
			FilePerm:       0o600,
			FlushEachWrite: true,
		})
		if err != nil {
			return fmt.Errorf("open audit writer: %w", err)
		}
		defer writer.Close()
		if err := writer.AppendJSON(event); err != nil {
			return fmt.Errorf("append audit event: %w", err)
		}
		return nil
	})
}

func (s *FileStore) ListAuditEvents(ctx context.Context, tickID string, contactID string, action string, limit int) ([]AuditEvent, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tickID = strings.TrimSpace(tickID)
	contactID = strings.TrimSpace(contactID)
	action = strings.TrimSpace(action)
	var out []AuditEvent
	err := s.withAuditLock(ctx, func() error {
		records, err := s.readAuditEventsJSONL(s.auditPathJSONL())
		if err != nil {
			return err
		}
		filtered := make([]AuditEvent, 0, len(records))
		for _, item := range records {
			if tickID != "" && strings.TrimSpace(item.TickID) != tickID {
				continue
			}
			if contactID != "" && strings.TrimSpace(item.ContactID) != contactID {
				continue
			}
			if action != "" && strings.TrimSpace(item.Action) != action {
				continue
			}
			filtered = append(filtered, item)
		}
		sort.Slice(filtered, func(i, j int) bool {
			if filtered[i].CreatedAt.Equal(filtered[j].CreatedAt) {
				return strings.TrimSpace(filtered[i].EventID) > strings.TrimSpace(filtered[j].EventID)
			}
			return filtered[i].CreatedAt.After(filtered[j].CreatedAt)
		})
		if limit > 0 && len(filtered) > limit {
			filtered = filtered[:limit]
		}
		out = make([]AuditEvent, len(filtered))
		copy(out, filtered)
		return nil
	})
	return out, err
}

func (s *FileStore) loadContactsMarkdownLocked(path string) ([]Contact, error) {
	content, exists, err := fsstore.ReadText(path)
	if err != nil {
		return nil, fmt.Errorf("read contacts markdown %s: %w", path, err)
	}
	if !exists {
		return []Contact{}, nil
	}
	records, err := parseContactsMarkdown(content)
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

func (s *FileStore) saveContactsMarkdownLocked(path string, title string, records []Contact) error {
	rendered, err := renderContactsMarkdown(title, records)
	if err != nil {
		return err
	}
	return fsstore.WriteTextAtomic(path, rendered, fsstore.FileOptions{
		DirPerm:  0o700,
		FilePerm: 0o600,
	})
}

func parseContactsMarkdown(content string) ([]Contact, error) {
	out := make([]Contact, 0, 64)
	scanner := bufio.NewScanner(strings.NewReader(content))
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		raw := strings.TrimSpace(strings.TrimPrefix(line, "- "))
		raw = strings.Trim(raw, "`")
		if raw == "" {
			continue
		}
		var item Contact
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func renderContactsMarkdown(title string, records []Contact) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Contacts"
	}
	items := make([]Contact, 0, len(records))
	for _, item := range records {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		return strings.TrimSpace(items[i].ContactID) < strings.TrimSpace(items[j].ContactID)
	})
	var b strings.Builder
	b.WriteString("# ")
	b.WriteString(title)
	b.WriteString("\n\n")
	b.WriteString("<!-- One JSON object per list item. -->\n")
	for _, item := range items {
		raw, err := json.Marshal(item)
		if err != nil {
			return "", err
		}
		b.WriteString("- ")
		b.Write(raw)
		b.WriteString("\n")
	}
	return b.String(), nil
}

func removeContactByID(items []Contact, contactID string, createdAt *time.Time) []Contact {
	out := items[:0]
	contactID = strings.TrimSpace(contactID)
	for _, item := range items {
		if strings.TrimSpace(item.ContactID) == contactID {
			if createdAt != nil && !item.CreatedAt.IsZero() {
				*createdAt = item.CreatedAt
			}
			continue
		}
		out = append(out, item)
	}
	return out
}

func (s *FileStore) loadCandidatesLocked() ([]ShareCandidate, error) {
	var file candidatesFile
	ok, err := readJSONFile(s.candidatesPath(), &file)
	if err != nil {
		return nil, err
	}
	if !ok {
		return []ShareCandidate{}, nil
	}
	out := make([]ShareCandidate, 0, len(file.Records))
	for _, item := range file.Records {
		item = normalizeCandidate(item, time.Now().UTC())
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return strings.TrimSpace(out[i].ItemID) < strings.TrimSpace(out[j].ItemID)
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out, nil
}

func (s *FileStore) saveCandidatesLocked(records []ShareCandidate) error {
	sort.Slice(records, func(i, j int) bool {
		if records[i].CreatedAt.Equal(records[j].CreatedAt) {
			return strings.TrimSpace(records[i].ItemID) < strings.TrimSpace(records[j].ItemID)
		}
		return records[i].CreatedAt.After(records[j].CreatedAt)
	})
	file := candidatesFile{Version: candidatesFileVersion, Records: records}
	return writeJSONFileAtomic(s.candidatesPath(), file)
}

func (s *FileStore) loadSessionsLocked() ([]SessionState, error) {
	var file sessionsFile
	ok, err := readJSONFile(s.sessionsPath(), &file)
	if err != nil {
		return nil, err
	}
	if !ok {
		return []SessionState{}, nil
	}
	out := make([]SessionState, 0, len(file.Records))
	for _, item := range file.Records {
		item = normalizeSessionState(item, time.Now().UTC())
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return strings.TrimSpace(out[i].SessionID) < strings.TrimSpace(out[j].SessionID)
		}
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	return out, nil
}

func (s *FileStore) saveSessionsLocked(records []SessionState) error {
	sort.Slice(records, func(i, j int) bool {
		if records[i].UpdatedAt.Equal(records[j].UpdatedAt) {
			return strings.TrimSpace(records[i].SessionID) < strings.TrimSpace(records[j].SessionID)
		}
		return records[i].UpdatedAt.After(records[j].UpdatedAt)
	})
	file := sessionsFile{Version: sessionsFileVersion, Records: records}
	return writeJSONFileAtomic(s.sessionsPath(), file)
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

func (s *FileStore) loadBusDeliveryLocked() ([]BusDeliveryRecord, error) {
	var file busDeliveryFile
	ok, err := readJSONFileStrict(s.busDeliveryPath(), &file)
	if err != nil {
		return nil, err
	}
	if !ok {
		return []BusDeliveryRecord{}, nil
	}
	if file.Version != busDeliveryFileVersion {
		return nil, fmt.Errorf("unsupported bus delivery file version: %d", file.Version)
	}
	out := make([]BusDeliveryRecord, 0, len(file.Records))
	for _, item := range file.Records {
		normalized, normalizeErr := normalizeBusDeliveryRecord(item)
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

func (s *FileStore) saveBusDeliveryLocked(records []BusDeliveryRecord) error {
	sort.Slice(records, func(i, j int) bool {
		if records[i].UpdatedAt.Equal(records[j].UpdatedAt) {
			iKey, _ := busOutboxRecordKey(records[i].Channel, records[i].IdempotencyKey)
			jKey, _ := busOutboxRecordKey(records[j].Channel, records[j].IdempotencyKey)
			return iKey < jKey
		}
		return records[i].UpdatedAt.After(records[j].UpdatedAt)
	})
	file := busDeliveryFile{Version: busDeliveryFileVersion, Records: records}
	return writeJSONFileAtomic(s.busDeliveryPath(), file)
}

func (s *FileStore) readAuditEventsJSONL(path string) ([]AuditEvent, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []AuditEvent{}, nil
		}
		return nil, fmt.Errorf("open audit jsonl %s: %w", path, err)
	}
	defer file.Close()

	records := make([]AuditEvent, 0, 64)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var event AuditEvent
		if err := json.Unmarshal(line, &event); err != nil {
			return nil, fmt.Errorf("decode audit jsonl %s: %w", path, err)
		}
		records = append(records, event)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan audit jsonl %s: %w", path, err)
	}
	return records, nil
}

func (s *FileStore) withStateLock(ctx context.Context, fn func() error) error {
	return s.withLock(ctx, "state.main", fn)
}

func (s *FileStore) withAuditLock(ctx context.Context, fn func() error) error {
	return s.withLock(ctx, "audit.share_decisions_jsonl", fn)
}

func (s *FileStore) withLock(ctx context.Context, key string, fn func() error) error {
	lockPath, err := fsstore.BuildLockPath(s.lockRootPath(), key)
	if err != nil {
		return err
	}
	return fsstore.WithLock(ctx, lockPath, fn)
}

func (s *FileStore) rootPath() string {
	root := strings.TrimSpace(s.root)
	if root == "" {
		return "contacts"
	}
	return filepath.Clean(root)
}

func (s *FileStore) lockRootPath() string {
	return filepath.Join(s.rootPath(), ".fslocks")
}

func (s *FileStore) activeContactsPath() string {
	return filepath.Join(s.rootPath(), "active.md")
}

func (s *FileStore) inactiveContactsPath() string {
	return filepath.Join(s.rootPath(), "inactive.md")
}

func (s *FileStore) candidatesPath() string {
	return filepath.Join(s.rootPath(), "share_candidates.json")
}

func (s *FileStore) sessionsPath() string {
	return filepath.Join(s.rootPath(), "share_sessions.json")
}

func (s *FileStore) busInboxPath() string {
	return filepath.Join(s.rootPath(), "bus_inbox.json")
}

func (s *FileStore) busOutboxPath() string {
	return filepath.Join(s.rootPath(), "bus_outbox.json")
}

func (s *FileStore) busDeliveryPath() string {
	return filepath.Join(s.rootPath(), "bus_delivery.json")
}

func (s *FileStore) auditPathJSONL() string {
	return filepath.Join(s.rootPath(), "share_decisions_audit.jsonl")
}

func normalizeContact(c Contact, now time.Time) Contact {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	c.ContactID = strings.TrimSpace(c.ContactID)
	c.ContactNickname = strings.TrimSpace(c.ContactNickname)
	c.PersonaBrief = strings.TrimSpace(c.PersonaBrief)
	c.Pronouns = clipString(strings.TrimSpace(c.Pronouns), contactPronounsMaxLen)
	c.Timezone = normalizeTimezone(strings.TrimSpace(c.Timezone))
	c.PreferenceContext = clipString(strings.TrimSpace(c.PreferenceContext), contactPrefMaxLen)
	c.DisplayName = strings.TrimSpace(c.DisplayName)
	if c.ContactNickname == "" && c.DisplayName != "" {
		c.ContactNickname = c.DisplayName
	}
	c.DisplayName = ""
	c.SubjectID = strings.TrimSpace(c.SubjectID)
	c.NodeID = strings.TrimSpace(c.NodeID)
	c.PeerID = strings.TrimSpace(c.PeerID)
	c.TrustState = strings.TrimSpace(strings.ToLower(c.TrustState))
	c.LastSharedItemID = strings.TrimSpace(c.LastSharedItemID)
	c.Kind = normalizeKind(c.Kind)
	c.Status = normalizeStatus(c.Status)
	c.Addresses = normalizeStringSlice(c.Addresses)
	c.ChannelEndpoints = normalizeChannelEndpoints(c.ChannelEndpoints)
	c.TopicWeights = normalizeTopicWeightsMap(cloneFloatMap(c.TopicWeights))
	c.PersonaTraits = normalizeTraitMap(c.PersonaTraits)
	c.UnderstandingDepth = clamp(c.UnderstandingDepth, 0, 100)
	c.ReciprocityNorm = clamp(c.ReciprocityNorm, 0, 1)
	c.RetainScore = clamp(c.RetainScore, 0, 1)
	if c.CreatedAt.IsZero() {
		c.CreatedAt = now
	}
	c.UpdatedAt = now
	if len(c.Addresses) == 0 {
		c.Addresses = nil
	}
	if len(c.TopicWeights) == 0 {
		c.TopicWeights = nil
	}
	if len(c.PersonaTraits) == 0 {
		c.PersonaTraits = nil
	}
	if len(c.ChannelEndpoints) == 0 {
		c.ChannelEndpoints = nil
	}
	return c
}

func clipString(input string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(input) <= max {
		return input
	}
	return input[:max]
}

func normalizeTimezone(raw string) string {
	raw = clipString(strings.TrimSpace(raw), contactTZMaxLen)
	if raw == "" {
		return ""
	}
	if _, err := time.LoadLocation(raw); err != nil {
		return ""
	}
	return raw
}

func normalizeCandidate(c ShareCandidate, now time.Time) ShareCandidate {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	c.ItemID = strings.TrimSpace(c.ItemID)
	c.Topic = strings.TrimSpace(c.Topic)
	c.ContentType = strings.TrimSpace(c.ContentType)
	c.PayloadBase64 = strings.TrimSpace(c.PayloadBase64)
	c.SensitivityLevel = strings.TrimSpace(strings.ToLower(c.SensitivityLevel))
	c.SourceRef = strings.TrimSpace(c.SourceRef)
	c.Topics = normalizeStringSlice(c.Topics)
	c.LinkedHistoryIDs = normalizeStringSlice(c.LinkedHistoryIDs)
	c.DepthHint = clamp(c.DepthHint, 0, 1)
	c.SourceChatType = strings.ToLower(strings.TrimSpace(c.SourceChatType))
	switch c.SourceChatType {
	case "private", "group", "supergroup":
	default:
		c.SourceChatType = ""
	}
	if c.CreatedAt.IsZero() {
		c.CreatedAt = now
	}
	c.UpdatedAt = now
	if len(c.Topics) == 0 {
		c.Topics = nil
	}
	if len(c.LinkedHistoryIDs) == 0 {
		c.LinkedHistoryIDs = nil
	}
	return c
}

func normalizeSessionState(s SessionState, now time.Time) SessionState {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.SessionID = strings.TrimSpace(s.SessionID)
	s.ContactID = strings.TrimSpace(s.ContactID)
	s.SessionInterestLevel = clamp(s.SessionInterestLevel, 0, 1)
	if s.StartedAt.IsZero() {
		s.StartedAt = now
	}
	s.UpdatedAt = now
	return s
}

func normalizeAuditEvent(e AuditEvent, now time.Time) AuditEvent {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	e.EventID = strings.TrimSpace(e.EventID)
	e.TickID = strings.TrimSpace(e.TickID)
	e.Action = strings.TrimSpace(e.Action)
	e.ContactID = strings.TrimSpace(e.ContactID)
	e.PeerID = strings.TrimSpace(e.PeerID)
	e.ItemID = strings.TrimSpace(e.ItemID)
	e.Reason = strings.TrimSpace(e.Reason)
	if e.Metadata != nil && len(e.Metadata) == 0 {
		e.Metadata = nil
	}
	if e.CreatedAt.IsZero() {
		e.CreatedAt = now
	}
	return e
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

func normalizeChannelEndpoints(input []ChannelEndpoint) []ChannelEndpoint {
	if len(input) == 0 {
		return nil
	}
	byKey := map[string]ChannelEndpoint{}
	for _, raw := range input {
		item := ChannelEndpoint{
			Channel:  strings.ToLower(strings.TrimSpace(raw.Channel)),
			Address:  strings.TrimSpace(raw.Address),
			ChatID:   raw.ChatID,
			ChatType: strings.ToLower(strings.TrimSpace(raw.ChatType)),
		}
		if item.Channel == "" {
			continue
		}
		if raw.LastSeenAt != nil && !raw.LastSeenAt.IsZero() {
			ts := raw.LastSeenAt.UTC()
			item.LastSeenAt = &ts
		}
		switch item.Channel {
		case ChannelTelegram:
			switch item.ChatType {
			case "private", "group", "supergroup":
			default:
				item.ChatType = ""
			}
			if item.Address == "" && item.ChatID != 0 {
				item.Address = strconv.FormatInt(item.ChatID, 10)
			}
		default:
			item.ChatID = 0
			item.ChatType = ""
		}
		key := ""
		if item.Channel == ChannelTelegram && item.ChatID != 0 {
			key = item.Channel + "#chat:" + strconv.FormatInt(item.ChatID, 10)
		} else if item.Address != "" {
			key = item.Channel + "#addr:" + item.Address
		}
		if key == "" {
			continue
		}
		prev, exists := byKey[key]
		if !exists {
			byKey[key] = item
			continue
		}
		merged := prev
		if merged.Address == "" && item.Address != "" {
			merged.Address = item.Address
		}
		if merged.ChatID == 0 && item.ChatID != 0 {
			merged.ChatID = item.ChatID
		}
		if merged.ChatType == "" && item.ChatType != "" {
			merged.ChatType = item.ChatType
		}
		if merged.LastSeenAt == nil || (item.LastSeenAt != nil && item.LastSeenAt.After(*merged.LastSeenAt)) {
			merged.LastSeenAt = item.LastSeenAt
		}
		byKey[key] = merged
	}
	if len(byKey) == 0 {
		return nil
	}
	out := make([]ChannelEndpoint, 0, len(byKey))
	for _, item := range byKey {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		ti := time.Time{}
		tj := time.Time{}
		if out[i].LastSeenAt != nil {
			ti = *out[i].LastSeenAt
		}
		if out[j].LastSeenAt != nil {
			tj = *out[j].LastSeenAt
		}
		if ti.Equal(tj) {
			if out[i].Channel != out[j].Channel {
				return out[i].Channel < out[j].Channel
			}
			if out[i].ChatID != out[j].ChatID {
				return out[i].ChatID < out[j].ChatID
			}
			return out[i].Address < out[j].Address
		}
		return ti.After(tj)
	})
	return out
}

func cloneFloatMap(input map[string]float64) map[string]float64 {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]float64, len(input))
	for k, v := range input {
		key := strings.TrimSpace(k)
		if key == "" {
			continue
		}
		out[key] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeTraitMap(input map[string]float64) map[string]float64 {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]float64, len(input))
	for rawKey, rawValue := range input {
		key := strings.ToLower(strings.TrimSpace(rawKey))
		if key == "" {
			continue
		}
		out[key] = clamp(rawValue, 0, 1)
	}
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

func normalizeBusDeliveryRecord(record BusDeliveryRecord) (BusDeliveryRecord, error) {
	channel, err := normalizeBusChannel(record.Channel)
	if err != nil {
		return BusDeliveryRecord{}, err
	}
	idempotencyKey := strings.TrimSpace(record.IdempotencyKey)
	if idempotencyKey == "" {
		return BusDeliveryRecord{}, fmt.Errorf("idempotency_key is required")
	}
	status, err := normalizeBusDeliveryStatus(record.Status)
	if err != nil {
		return BusDeliveryRecord{}, err
	}
	if record.Attempts <= 0 {
		return BusDeliveryRecord{}, fmt.Errorf("attempts must be > 0")
	}
	createdAt := record.CreatedAt.UTC()
	updatedAt := record.UpdatedAt.UTC()
	if createdAt.IsZero() {
		return BusDeliveryRecord{}, fmt.Errorf("created_at is required")
	}
	if updatedAt.IsZero() {
		return BusDeliveryRecord{}, fmt.Errorf("updated_at is required")
	}
	if updatedAt.Before(createdAt) {
		return BusDeliveryRecord{}, fmt.Errorf("updated_at must be >= created_at")
	}
	normalized := BusDeliveryRecord{
		Channel:        channel,
		IdempotencyKey: idempotencyKey,
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
			return BusDeliveryRecord{}, fmt.Errorf("last_attempt_at must not be zero")
		}
		normalized.LastAttemptAt = &ts
	}
	if record.SentAt != nil {
		ts := record.SentAt.UTC()
		if ts.IsZero() {
			return BusDeliveryRecord{}, fmt.Errorf("sent_at must not be zero")
		}
		normalized.SentAt = &ts
	}
	if normalized.Status == BusDeliveryStatusSent && normalized.SentAt == nil {
		return BusDeliveryRecord{}, fmt.Errorf("sent_at is required when status=sent")
	}
	if normalized.Status != BusDeliveryStatusSent && normalized.SentAt != nil {
		return BusDeliveryRecord{}, fmt.Errorf("sent_at must be empty when status is not sent")
	}
	if normalized.Status == BusDeliveryStatusFailed && normalized.LastError == "" {
		return BusDeliveryRecord{}, fmt.Errorf("last_error is required when status=failed")
	}
	if normalized.Status != BusDeliveryStatusFailed && normalized.LastError != "" {
		return BusDeliveryRecord{}, fmt.Errorf("last_error must be empty when status is not failed")
	}
	return normalized, nil
}

func readJSONFile(path string, out any) (bool, error) {
	ok, err := fsstore.ReadJSON(path, out)
	if err != nil {
		return false, fmt.Errorf("read %s: %w", path, err)
	}
	return ok, nil
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
	return fsstore.WriteJSONAtomic(path, v, fsstore.FileOptions{
		DirPerm:  0o700,
		FilePerm: 0o600,
	})
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

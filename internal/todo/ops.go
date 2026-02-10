package todo

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/entryutil"
)

var (
	refIDPatternA = regexp.MustCompile(`^tg:-?\d+$`)
	refIDPatternB = regexp.MustCompile(`^tg:@[A-Za-z0-9_]+$`)
	refIDPatternC = regexp.MustCompile(`^maep:[A-Za-z0-9._-]+$`)
	refIDPatternD = regexp.MustCompile(`^slack:[A-Za-z0-9._:-]+$`)
	refIDPatternE = regexp.MustCompile(`^discord:[A-Za-z0-9._:-]+$`)
)

func (s *Store) Add(ctx context.Context, raw string) (UpdateResult, error) {
	return s.AddWithChatID(ctx, raw, "")
}

func (s *Store) AddWithChatID(ctx context.Context, raw string, chatID string) (UpdateResult, error) {
	wip, done, err := s.readFiles()
	if err != nil {
		return UpdateResult{}, err
	}
	now := s.nowUTC().Format(TimestampLayout)
	entry, err := ParseEntryFromInput(raw, now)
	if err != nil {
		return UpdateResult{}, err
	}
	if parsedChatID := normalizeEntryChatID(chatID); parsedChatID != "" {
		entry.ChatID = parsedChatID
	}
	if err := validateWIPEntry(entry); err != nil {
		return UpdateResult{}, err
	}
	wip.Entries = append([]Entry{entry}, wip.Entries...)
	deduped, err := s.dedupeWIPEntries(ctx, wip.Entries)
	if err != nil {
		return UpdateResult{}, err
	}
	wip.Entries = deduped
	if err := s.writeFiles(wip, done); err != nil {
		return UpdateResult{}, err
	}
	return UpdateResult{
		OK:     true,
		Action: "add",
		UpdatedCounts: Counts{
			OpenCount: len(wip.Entries),
			DoneCount: len(done.Entries),
		},
		Changed: Changed{
			WIPAdded:   1,
			WIPRemoved: 0,
			DONEAdded:  0,
		},
		Entry: &entry,
	}, nil
}

func (s *Store) AddWithChannel(ctx context.Context, raw string, channel string) (UpdateResult, error) {
	return s.AddWithChatID(ctx, raw, channel)
}

func (s *Store) Complete(ctx context.Context, raw string) (UpdateResult, error) {
	query, err := normalizeCompleteQuery(raw)
	if err != nil {
		return UpdateResult{}, err
	}
	wip, done, err := s.readFiles()
	if err != nil {
		return UpdateResult{}, err
	}
	if err := validateWIPEntries(wip.Entries); err != nil {
		return UpdateResult{}, err
	}
	if len(wip.Entries) == 0 {
		return UpdateResult{}, fmt.Errorf("no matching todo item in TODO.md")
	}
	semantic, err := s.semanticResolver()
	if err != nil {
		return UpdateResult{}, err
	}
	idx, err := semantic.MatchCompleteIndex(ctx, query, wip.Entries)
	if err != nil {
		return UpdateResult{}, err
	}
	if idx < 0 || idx >= len(wip.Entries) {
		return UpdateResult{}, fmt.Errorf("no matching todo item in TODO.md")
	}
	target := wip.Entries[idx]
	wip.Entries = append(append([]Entry{}, wip.Entries[:idx]...), wip.Entries[idx+1:]...)
	doneEntry := Entry{
		Done:      true,
		CreatedAt: target.CreatedAt,
		DoneAt:    s.nowUTC().Format(TimestampLayout),
		ChatID:    normalizeEntryChatID(target.ChatID),
		Content:   strings.TrimSpace(target.Content),
	}
	done.Entries = append([]Entry{doneEntry}, done.Entries...)
	if err := s.writeFiles(wip, done); err != nil {
		return UpdateResult{}, err
	}
	return UpdateResult{
		OK:     true,
		Action: "complete",
		UpdatedCounts: Counts{
			OpenCount: len(wip.Entries),
			DoneCount: len(done.Entries),
		},
		Changed: Changed{
			WIPAdded:   0,
			WIPRemoved: 1,
			DONEAdded:  1,
		},
		Entry: &doneEntry,
	}, nil
}

func (s *Store) List(scope string) (ListResult, error) {
	scope = strings.ToLower(strings.TrimSpace(scope))
	if scope == "" {
		scope = "wip"
	}
	switch scope {
	case "wip", "done", "both":
	default:
		return ListResult{}, fmt.Errorf("invalid scope: %s", scope)
	}

	wip, done, err := s.readFiles()
	if err != nil {
		return ListResult{}, err
	}
	out := ListResult{
		Scope:       scope,
		OpenCount:   len(wip.Entries),
		DoneCount:   len(done.Entries),
		WIPPath:     s.WIPPath,
		DONEPath:    s.DONEPath,
		GeneratedAt: s.nowUTC().Format(time.RFC3339),
	}
	if scope == "wip" || scope == "both" {
		out.WIPItems = append([]Entry{}, wip.Entries...)
	}
	if scope == "done" || scope == "both" {
		out.DONEItems = append([]Entry{}, done.Entries...)
	}
	return out, nil
}

func validTimestamp(v string) bool {
	return entryutil.IsValidTimestamp(v)
}

func normalizeCompleteQuery(raw string) (string, error) {
	query := strings.TrimSpace(raw)
	if query == "" {
		return "", fmt.Errorf("content is required")
	}
	if done, ok := parseDONEEntryLine(query); ok {
		query = done.Content
	} else if wip, ok := parseWIPEntryLine(query); ok {
		query = wip.Content
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return "", fmt.Errorf("content is required")
	}
	return query, nil
}

func (s *Store) semanticResolver() (SemanticResolver, error) {
	if s == nil || s.Semantics == nil {
		return nil, fmt.Errorf("todo semantic resolver is required")
	}
	return s.Semantics, nil
}

func (s *Store) dedupeWIPEntries(ctx context.Context, entries []Entry) ([]Entry, error) {
	if err := validateWIPEntries(entries); err != nil {
		return nil, err
	}
	if len(entries) <= 1 {
		return append([]Entry{}, entries...), nil
	}
	semantic, err := s.semanticResolver()
	if err != nil {
		return nil, err
	}
	items := make([]entryutil.SemanticItem, 0, len(entries))
	for _, item := range entries {
		items = append(items, entryutil.SemanticItem{
			CreatedAt: strings.TrimSpace(item.CreatedAt),
			Content:   strings.TrimSpace(item.Content),
		})
	}
	keepIndices, err := entryutil.ResolveKeepIndices(ctx, items, semantic)
	if err != nil {
		return nil, err
	}
	keep := make(map[int]bool, len(keepIndices))
	for _, idx := range keepIndices {
		keep[idx] = true
	}
	out := make([]Entry, 0, len(keep))
	for i, item := range entries {
		if !keep[i] {
			continue
		}
		out = append(out, item)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("semantic dedupe removed all todo items")
	}
	if err := validateWIPEntries(out); err != nil {
		return nil, err
	}
	return out, nil
}

func validateWIPEntries(entries []Entry) error {
	for _, item := range entries {
		if err := validateWIPEntry(item); err != nil {
			return err
		}
	}
	return nil
}

func validateWIPEntry(item Entry) error {
	if !validTimestamp(item.CreatedAt) {
		return fmt.Errorf("invalid CreatedAt: %s", strings.TrimSpace(item.CreatedAt))
	}
	if err := validateEntryChatID(item.ChatID); err != nil {
		return err
	}
	if err := validateEntryReferences(item.Content); err != nil {
		return err
	}
	return nil
}

func validateEntryReferences(content string) error {
	_, err := ExtractReferenceIDs(content)
	return err
}

func isValidReferenceID(ref string) bool {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return false
	}
	if refIDPatternA.MatchString(ref) ||
		refIDPatternB.MatchString(ref) ||
		refIDPatternC.MatchString(ref) ||
		refIDPatternD.MatchString(ref) ||
		refIDPatternE.MatchString(ref) {
		return true
	}
	return false
}

func normalizeEntryChatID(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

func validateEntryChatID(raw string) error {
	chatID := normalizeEntryChatID(raw)
	if chatID == "" {
		return nil
	}
	if !isValidTODOChatID(chatID) {
		return fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	return nil
}

func isValidTODOChatID(chatID string) bool {
	chatID = normalizeEntryChatID(chatID)
	if !refIDPatternA.MatchString(chatID) {
		return false
	}
	idText := strings.TrimSpace(strings.TrimPrefix(chatID, "tg:"))
	id, err := strconv.ParseInt(idText, 10, 64)
	if err != nil {
		return false
	}
	return id != 0
}

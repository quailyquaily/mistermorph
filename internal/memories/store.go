package memories

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
)

const (
	// MaxPerSubject bounds the memories one audience keeps about one subject.
	MaxPerSubject = 64
	// MaxPerAudience bounds the memories saved from one audience, so one busy conversation cannot
	// fill the store.
	MaxPerAudience = 256

	defaultSearchLimit = 10
	maxSearchLimit     = 50
	// MaxConsoleResults is how many memories the Console lists at once.
	MaxConsoleResults = 1000
	minTrigramRunes   = 3
)

const schemaSQL = `
CREATE TABLE memories (
	id              TEXT PRIMARY KEY,
	subject         TEXT NOT NULL,
	name            TEXT NOT NULL,
	type            TEXT NOT NULL,
	description     TEXT NOT NULL,
	body            TEXT NOT NULL,
	visibility      TEXT NOT NULL,
	learned_in      TEXT NOT NULL,
	told_by         TEXT NOT NULL DEFAULT '',
	source_events   TEXT NOT NULL DEFAULT '[]',
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL,
	updated_by_task TEXT NOT NULL DEFAULT '',
	UNIQUE (subject, learned_in, name)
);
CREATE INDEX memories_learned_in ON memories (learned_in);
CREATE INDEX memories_told_by ON memories (told_by) WHERE told_by != '';

CREATE VIRTUAL TABLE memory_text USING fts5 (
	name, description, body,
	content = 'memories',
	tokenize = 'trigram'
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
	INSERT INTO memory_text (rowid, name, description, body) VALUES (new.rowid, new.name, new.description, new.body);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
	INSERT INTO memory_text (memory_text, rowid, name, description, body) VALUES ('delete', old.rowid, old.name, old.description, old.body);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
	INSERT INTO memory_text (memory_text, rowid, name, description, body) VALUES ('delete', old.rowid, old.name, old.description, old.body);
	INSERT INTO memory_text (rowid, name, description, body) VALUES (new.rowid, new.name, new.description, new.body);
END;

CREATE TABLE memory_review (
	audience         TEXT PRIMARY KEY,
	turns_since_save INTEGER NOT NULL,
	updated_at       TEXT NOT NULL
);
`

func migrations() []sqlitedb.Migration {
	return []sqlitedb.Migration{
		{Name: "create memories", SQL: schemaSQL},
		{Name: "create memory meta", SQL: `CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`},
	}
}

// Store is the memories in memory.db.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(ctx context.Context, path string) (*Store, error) {
	db, err := sqlitedb.Open(ctx, path, migrations())
	if err != nil {
		return nil, fmt.Errorf("open memories: %w", err)
	}
	return &Store{db: db, now: time.Now}, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// SaveResult is what a save did.
type SaveResult struct {
	Memory  Memory
	Created bool
	// Notes tell the model what the rules changed, such as a narrowed visibility.
	Notes []string
}

// Save creates the memory or replaces the one with the same subject and name that was learned in
// the same audience. The write rules decide what a may save; a refusal is a *RuleError.
func (s *Store) Save(ctx context.Context, a audience.Audience, d Draft) (SaveResult, error) {
	m, notes, err := checkWrite(a, d)
	if err != nil {
		return SaveResult{}, err
	}
	sources, err := json.Marshal(nonNil(m.SourceEvents))
	if err != nil {
		return SaveResult{}, err
	}
	now := s.now().UTC().Format(time.RFC3339Nano)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SaveResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var existingID, createdAt string
	err = tx.QueryRowContext(ctx, `SELECT id, created_at FROM memories WHERE subject = ? AND learned_in = ? AND name = ?`,
		m.Subject, m.LearnedIn, m.Name).Scan(&existingID, &createdAt)
	switch {
	case err == nil:
		m.ID, m.CreatedAt, m.UpdatedAt = existingID, createdAt, now
		if _, err := tx.ExecContext(ctx, `UPDATE memories SET type = ?, description = ?, body = ?, visibility = ?, told_by = ?,
			source_events = ?, updated_at = ?, updated_by_task = ? WHERE id = ?`,
			m.Type, m.Description, m.Body, m.Visibility, m.ToldBy, string(sources), now, m.UpdatedByTask, m.ID); err != nil {
			return SaveResult{}, fmt.Errorf("save memory: %w", err)
		}
	case errors.Is(err, sql.ErrNoRows):
		var perSubject, perAudience int
		if err := tx.QueryRowContext(ctx, `SELECT
			(SELECT count(*) FROM memories WHERE subject = ? AND learned_in = ?),
			(SELECT count(*) FROM memories WHERE learned_in = ?)`, m.Subject, m.LearnedIn, m.LearnedIn).Scan(&perSubject, &perAudience); err != nil {
			return SaveResult{}, fmt.Errorf("save memory: %w", err)
		}
		if perSubject >= MaxPerSubject {
			return SaveResult{}, refuse("there are already %d memories about %s from here; merge this into one of them or forget one first", perSubject, m.Subject)
		}
		if perAudience >= MaxPerAudience {
			return SaveResult{}, refuse("there are already %d memories from this conversation; merge this into one of them or forget one first", perAudience)
		}
		m.ID, m.CreatedAt, m.UpdatedAt = "mem_"+uuid.NewString(), now, now
		if _, err := tx.ExecContext(ctx, `INSERT INTO memories (id, subject, name, type, description, body, visibility, learned_in,
			told_by, source_events, created_at, updated_at, updated_by_task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			m.ID, m.Subject, m.Name, m.Type, m.Description, m.Body, m.Visibility, m.LearnedIn, m.ToldBy, string(sources),
			m.CreatedAt, m.UpdatedAt, m.UpdatedByTask); err != nil {
			return SaveResult{}, fmt.Errorf("save memory: %w", err)
		}
	default:
		return SaveResult{}, fmt.Errorf("save memory: %w", err)
	}
	// A save is what the reminder waits for.
	if _, err := tx.ExecContext(ctx, `INSERT INTO memory_review (audience, turns_since_save, updated_at) VALUES (?, 0, ?)
		ON CONFLICT (audience) DO UPDATE SET turns_since_save = 0, updated_at = excluded.updated_at`, m.LearnedIn, now); err != nil {
		return SaveResult{}, fmt.Errorf("save memory: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return SaveResult{}, fmt.Errorf("save memory: %w", err)
	}
	return SaveResult{Memory: m, Created: existingID == "", Notes: notes}, nil
}

// Get returns the memory with id when a may hear it. A memory a may not hear is reported as not
// found, so its existence does not leak.
func (s *Store) Get(ctx context.Context, a audience.Audience, id string) (Memory, bool, error) {
	items, err := s.query(ctx, `WHERE id = ?`, strings.TrimSpace(id))
	if err != nil || len(items) == 0 {
		return Memory{}, false, err
	}
	if !CanHear(a, items[0]) {
		return Memory{}, false, nil
	}
	return items[0], true, nil
}

// Forget deletes a memory. The owner may forget anything it can see; another audience only what
// was learned in it. It reports false when there was nothing a may forget.
func (s *Store) Forget(ctx context.Context, a audience.Audience, id string) (bool, error) {
	m, ok, err := s.Get(ctx, a, id)
	if err != nil || !ok {
		return false, err
	}
	if !canChange(a, m) {
		return false, refuse("only the owner, or the conversation it was learned in, can forget %s", m.Name)
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM memories WHERE id = ?`, m.ID)
	if err != nil {
		return false, fmt.Errorf("forget memory: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Edit is a change the owner makes to a memory from the Console. Empty fields stay as they are.
type Edit struct {
	Type        Type       `json:"type,omitempty"`
	Description string     `json:"description,omitempty"`
	Body        string     `json:"body,omitempty"`
	Visibility  Visibility `json:"visibility,omitempty"`
}

// EditAsOwner changes a memory. Only the owner edits memories this way, so any visibility is
// allowed, including widening one a conversation saved.
func (s *Store) EditAsOwner(ctx context.Context, id string, e Edit) (Memory, bool, error) {
	m, ok, err := s.Get(ctx, audience.Owner(), id)
	if err != nil || !ok {
		return Memory{}, ok, err
	}
	if t := strings.TrimSpace(string(e.Type)); t != "" {
		m.Type = Type(t)
	}
	if d := strings.TrimSpace(e.Description); d != "" {
		m.Description = d
	}
	if b := strings.TrimSpace(e.Body); b != "" {
		m.Body = b
	}
	if v := strings.TrimSpace(string(e.Visibility)); v != "" {
		if widthOf(Visibility(v)) < 0 {
			return Memory{}, true, refuse("visibility must be private, conversation or public, not %q", v)
		}
		m.Visibility = Visibility(v)
	}
	if err := validateFields(&m, nil); err != nil {
		return Memory{}, true, err
	}
	m.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
	if _, err := s.db.ExecContext(ctx, `UPDATE memories SET type = ?, description = ?, body = ?, visibility = ?, updated_at = ? WHERE id = ?`,
		m.Type, m.Description, m.Body, m.Visibility, m.UpdatedAt, m.ID); err != nil {
		return Memory{}, true, fmt.Errorf("edit memory: %w", err)
	}
	return m, true, nil
}

// SearchAsOwner is Search for the owner's Console, which hears every memory and lists up to
// MaxConsoleResults instead of the model's limit.
func (s *Store) SearchAsOwner(ctx context.Context, opts SearchOptions) ([]Memory, bool, error) {
	return s.search(ctx, audience.Owner(), opts, MaxConsoleResults)
}

// ForgetAsOwner deletes a memory from the Console.
func (s *Store) ForgetAsOwner(ctx context.Context, id string) (bool, error) {
	return s.Forget(ctx, audience.Owner(), id)
}

// DeleteSubject deletes every memory about subject, for a contact that is deleted. Memories that
// contact told about others stay.
func (s *Store) DeleteSubject(ctx context.Context, subject string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM memories WHERE subject = ?`, strings.TrimSpace(subject))
	if err != nil {
		return 0, fmt.Errorf("delete memories: %w", err)
	}
	return res.RowsAffected()
}

// SearchOptions selects memories by their text.
type SearchOptions struct {
	// Query is matched as words, all of which must appear. Empty matches everything.
	Query   string
	Subject string
	Type    Type
	// Limit defaults to 10 and is at most 50. Results are the most recently updated first.
	Limit int
}

// Search returns memories a may hear, and whether more matched than the limit.
func (s *Store) Search(ctx context.Context, a audience.Audience, opts SearchOptions) ([]Memory, bool, error) {
	return s.search(ctx, a, opts, maxSearchLimit)
}

func (s *Store) search(ctx context.Context, a audience.Audience, opts SearchOptions, maxLimit int) ([]Memory, bool, error) {
	hear, hearArgs, ok := hearableSQL(a)
	if !ok {
		return nil, false, nil
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	where := []string{hear}
	args := append([]any(nil), hearArgs...)
	var match []string
	for _, term := range strings.Fields(opts.Query) {
		if utf8.RuneCountInString(term) >= minTrigramRunes {
			match = append(match, `"`+strings.ReplaceAll(term, `"`, `""`)+`"`)
			continue
		}
		where = append(where, `(name || ' ' || description || ' ' || body) LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(term)+"%")
	}
	if len(match) > 0 {
		where = append(where, `rowid IN (SELECT rowid FROM memory_text WHERE memory_text MATCH ?)`)
		args = append(args, strings.Join(match, " "))
	}
	if subject := strings.TrimSpace(opts.Subject); subject != "" {
		where = append(where, `subject = ?`)
		args = append(args, subject)
	}
	if t := strings.TrimSpace(string(opts.Type)); t != "" {
		where = append(where, `type = ?`)
		args = append(args, t)
	}
	args = append(args, limit+1)
	items, err := s.query(ctx, `WHERE `+strings.Join(where, " AND ")+` ORDER BY updated_at DESC, id LIMIT ?`, args...)
	if err != nil {
		return nil, false, err
	}
	items = filterHearable(a, items)
	more := len(items) > limit
	if more {
		items = items[:limit]
	}
	return items, more, nil
}

// ForPrompt is what a run sees without searching: for the owner, memories about the owner and
// general ones; for a contact, what they may hear about themselves and public general ones; for a
// conversation, what was learned in it, public general ones, and public memories about the
// participants given. Most recently updated first, at most limit.
func (s *Store) ForPrompt(ctx context.Context, a audience.Audience, participants []string, limit int) ([]Memory, bool, error) {
	if limit <= 0 {
		limit = MaxPerSubject
	}
	items, err := s.promptCandidates(ctx, a, participants, limit+1)
	if err != nil {
		return nil, false, err
	}
	more := len(items) > limit
	if more {
		items = items[:limit]
	}
	return items, more, nil
}

// maxPromptCandidates bounds the memories ForRun scores. An audience hears at most a few hundred.
const maxPromptCandidates = 1024

// RunMemories is what ForRun picked for a run: the memories to show, the IDs of those the run's
// messages are about, and whether more exist than are shown.
type RunMemories struct {
	Items    []Memory
	Relevant map[string]bool
	More     bool
}

// ForRun picks the memories a run sees without searching, from those ForPrompt would consider:
// first the ones query is about (Rank, favoring the participants), then every feedback memory, since
// it says how to work, then the newest of the rest, at most limit in all.
func (s *Store) ForRun(ctx context.Context, a audience.Audience, participants []string, query string, limit int) (RunMemories, error) {
	if limit <= 0 {
		limit = MaxPerSubject
	}
	all, err := s.promptCandidates(ctx, a, participants, maxPromptCandidates)
	if err != nil {
		return RunMemories{}, err
	}
	var favored []string
	for _, id := range participants {
		if id = strings.TrimSpace(id); id != "" {
			favored = append(favored, audience.Contact(id).String())
		}
	}
	return pickRunMemories(all, Rank(all, query, RankOptions{Subjects: favored, Now: s.now()}), limit), nil
}

// pickRunMemories orders all (newest first) for a run: the ranked matches, then feedback, then the
// rest, at most limit.
func pickRunMemories(all []Memory, ranked []Ranked, limit int) RunMemories {
	out := RunMemories{Relevant: map[string]bool{}}
	taken := map[string]bool{}
	take := func(m Memory) {
		if len(out.Items) < limit && !taken[m.ID] {
			taken[m.ID] = true
			out.Items = append(out.Items, m)
		}
	}
	for _, r := range ranked {
		take(r.Memory)
		if taken[r.Memory.ID] {
			out.Relevant[r.Memory.ID] = true
		}
	}
	for _, m := range all {
		if m.Type == TypeFeedback {
			take(m)
		}
	}
	for _, m := range all {
		take(m)
	}
	out.More = len(all) > len(out.Items)
	return out
}

// promptCandidates are the memories a run with audience a may see without searching, newest first,
// at most limit.
func (s *Store) promptCandidates(ctx context.Context, a audience.Audience, participants []string, limit int) ([]Memory, error) {
	var where string
	var args []any
	switch a.Kind {
	case audience.KindOwner:
		where, args = `subject IN ('owner', 'general')`, nil
	case audience.KindContact:
		where = `(subject = ? OR (subject = 'general' AND visibility = 'public'))`
		args = []any{a.String()}
	case audience.KindConversation:
		where = `(learned_in = ? OR (subject = 'general' AND visibility = 'public')`
		args = []any{a.String()}
		var subjects []string
		for _, id := range participants {
			if id = strings.TrimSpace(id); id != "" {
				subjects = append(subjects, "?")
				args = append(args, audience.Contact(id).String())
			}
		}
		if len(subjects) > 0 {
			where += ` OR (visibility = 'public' AND subject IN (` + strings.Join(subjects, ", ") + `))`
		}
		where += `)`
	default:
		return nil, nil
	}
	hear, hearArgs, _ := hearableSQL(a)
	args = append(args, hearArgs...)
	args = append(args, limit)
	items, err := s.query(ctx, `WHERE `+where+` AND `+hear+` ORDER BY updated_at DESC, id LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	return filterHearable(a, items), nil
}

// List returns every memory, for the owner's Console.
func (s *Store) List(ctx context.Context) ([]Memory, error) {
	return s.query(ctx, `ORDER BY subject, updated_at DESC, id`)
}

// hearableSQL is CanHear as a WHERE clause, so a search does not read memories it must drop. The
// rows are checked with CanHear again.
func hearableSQL(a audience.Audience) (string, []any, bool) {
	switch a.Kind {
	case audience.KindOwner:
		return `1 = 1`, nil, true
	case audience.KindContact:
		here := a.String()
		return `(visibility = 'public' OR (visibility = 'private' AND learned_in = ?) OR (visibility = 'conversation' AND (subject = ? OR told_by = ?)))`,
			[]any{here, here, a.ID}, true
	case audience.KindConversation:
		return `(visibility = 'public' OR (visibility = 'conversation' AND learned_in = ?))`, []any{a.String()}, true
	}
	return "", nil, false
}

func filterHearable(a audience.Audience, items []Memory) []Memory {
	out := items[:0]
	for _, m := range items {
		if CanHear(a, m) {
			out = append(out, m)
		}
	}
	return out
}

const memoryColumns = `id, subject, name, type, description, body, visibility, learned_in, told_by, source_events, created_at, updated_at, updated_by_task`

func (s *Store) query(ctx context.Context, tail string, args ...any) ([]Memory, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+memoryColumns+` FROM memories `+tail, args...)
	if err != nil {
		return nil, fmt.Errorf("read memories: %w", err)
	}
	defer rows.Close()
	var out []Memory
	for rows.Next() {
		var m Memory
		var sources string
		if err := rows.Scan(&m.ID, &m.Subject, &m.Name, &m.Type, &m.Description, &m.Body, &m.Visibility, &m.LearnedIn,
			&m.ToldBy, &sources, &m.CreatedAt, &m.UpdatedAt, &m.UpdatedByTask); err != nil {
			return nil, fmt.Errorf("read memories: %w", err)
		}
		_ = json.Unmarshal([]byte(sources), &m.SourceEvents)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read memories: %w", err)
	}
	return out, nil
}

func nonNil(items []string) []string {
	if items == nil {
		return []string{}
	}
	return items
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

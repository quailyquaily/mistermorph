// Package domainjournal is the append-only record of what happened: tasks, topics, untriggered
// messages, agent pairing. It is the final truth that projections, observations and journal search
// read. Events live in <dir>/journal.db (SQLite); JSONL segments from older versions are imported
// once and left on disk.
package domainjournal

import (
	"bytes"
	"compress/flate"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
)

const (
	// DBFilename is the journal database inside the journal directory.
	DBFilename = "journal.db"

	segmentPrefix = "events."
	segmentSuffix = ".jsonl"

	replayBatchSize = 500
)

type Trace struct {
	TraceID string `json:"trace_id,omitempty"`
	Runtime string `json:"runtime,omitempty"`
	Target  string `json:"target,omitempty"`
	TopicID string `json:"topic_id,omitempty"`
	TaskID  string `json:"task_id,omitempty"`
}

type Event struct {
	ID            string `json:"id"`
	Time          string `json:"time"`
	Domain        string `json:"domain"`
	Type          string `json:"type"`
	SchemaVersion int    `json:"schema_version"`
	Trace         Trace  `json:"trace,omitempty"`
	// Audience is who may hear this event through journal search: "owner", "contact:<id>" or
	// "conversation:<key>". Empty means the owner only.
	Audience string          `json:"audience,omitempty"`
	Payload  json.RawMessage `json:"payload"`
}

type JournalOptions struct {
	Dir string
	// RotateMaxBytes applied to JSONL segments, which the journal no longer writes. It is accepted
	// and ignored.
	RotateMaxBytes int64
	// SyncEachWrite makes every append reach the disk before Append returns.
	SyncEachWrite bool
}

type Journal struct {
	dir    string
	db     *sql.DB
	mu     sync.Mutex
	closed bool
}

// Cursor is a position in the journal: replay from it starts after the event it names. Seq is the
// event's sequence number; zero is the start. File, Line and Byte were positions in JSONL segments
// and are only read from projection snapshots written by older versions, which treat them as
// invalid and replay from the start.
type Cursor struct {
	Seq  int64  `json:"seq,omitempty"`
	File string `json:"file,omitempty"`
	Line int64  `json:"line,omitempty"`
	Byte int64  `json:"byte,omitempty"`
}

// RecordRef names one event, by its sequence number.
type RecordRef struct {
	Seq int64 `json:"seq"`
}

type Record struct {
	Cursor Cursor    `json:"cursor"`
	Ref    RecordRef `json:"ref"`
	Event  Event     `json:"event"`
}

type IndexRecord struct {
	Key string    `json:"key"`
	Ref RecordRef `json:"ref"`
}

func New(opts JournalOptions) (*Journal, error) {
	dir := strings.TrimSpace(opts.Dir)
	if dir == "" {
		return nil, fmt.Errorf("journal dir is required")
	}
	cleanDir := filepath.Clean(dir)
	db, err := sqlitedb.OpenWithOptions(context.Background(), filepath.Join(cleanDir, DBFilename), migrations(cleanDir), sqlitedb.Options{
		Durable: opts.SyncEachWrite,
	})
	if err != nil {
		return nil, fmt.Errorf("open journal: %w", err)
	}
	return &Journal{dir: cleanDir, db: db}, nil
}

// openDir opens the journal in dir for a one-off read. A directory that does not exist holds no
// events, and reading it creates nothing.
func openDir(dir string) (*Journal, bool, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil, false, fmt.Errorf("journal dir is required")
	}
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	j, err := New(JournalOptions{Dir: dir})
	if err != nil {
		return nil, false, err
	}
	return j, true, nil
}

// handle is the database for an append. A closed journal refuses appends.
func (j *Journal) handle() (*sql.DB, error) {
	if j == nil {
		return nil, fmt.Errorf("journal is nil")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil, fmt.Errorf("journal is closed")
	}
	return j.db, nil
}

// readHandle is the database for a read, and the function that releases it. A closed journal can
// still be read, as the JSONL journal could: callers close their writer and keep their projection
// readable. The read then opens the database for itself.
func (j *Journal) readHandle() (*sql.DB, func(), error) {
	if j == nil {
		return nil, nil, fmt.Errorf("journal is nil")
	}
	j.mu.Lock()
	closed := j.closed
	db := j.db
	j.mu.Unlock()
	if !closed {
		return db, func() {}, nil
	}
	reopened, err := sqlitedb.Open(context.Background(), filepath.Join(j.dir, DBFilename), migrations(j.dir))
	if err != nil {
		return nil, nil, fmt.Errorf("open journal: %w", err)
	}
	return reopened, func() { _ = reopened.Close() }, nil
}

func (j *Journal) Append(event Event) (Cursor, error) {
	if j == nil {
		return Cursor{}, fmt.Errorf("journal is nil")
	}
	if err := ValidateEvent(event); err != nil {
		return Cursor{}, err
	}
	db, err := j.handle()
	if err != nil {
		return Cursor{}, err
	}
	seq, err := insertEvent(context.Background(), db, event)
	if err != nil {
		return Cursor{}, err
	}
	return Cursor{Seq: seq}, nil
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func insertEvent(ctx context.Context, db execer, event Event) (int64, error) {
	payload, err := compress(event.Payload)
	if err != nil {
		return 0, fmt.Errorf("compress journal payload: %w", err)
	}
	var atMS int64
	if at, err := time.Parse(time.RFC3339Nano, event.Time); err == nil {
		atMS = at.UnixMilli()
	}
	res, err := db.ExecContext(ctx, `INSERT INTO journal_events
		(id, time, at_ms, domain, type, schema_version, trace_id, runtime, target, topic_id, task_id, audience, text, payload)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		event.ID, event.Time, atMS, event.Domain, event.Type, event.SchemaVersion,
		strings.TrimSpace(event.Trace.TraceID), strings.TrimSpace(event.Trace.Runtime), strings.TrimSpace(event.Trace.Target),
		strings.TrimSpace(event.Trace.TopicID), strings.TrimSpace(event.Trace.TaskID),
		strings.TrimSpace(event.Audience), searchText(event), payload)
	if err != nil {
		return 0, fmt.Errorf("append journal event: %w", err)
	}
	return res.LastInsertId()
}

// IndexError reported failures of the derived JSONL index. Task and topic lookups are SQL indexes
// now, which fail with the append itself, so it is always nil.
func (j *Journal) IndexError() error {
	return nil
}

// RebuildIndexes rebuilt the derived JSONL index. SQL indexes need no rebuild; it only checks that
// the journal is open.
func (j *Journal) RebuildIndexes() error {
	_, err := j.handle()
	return err
}

func (j *Journal) Replay(fn func(Record) error) error {
	if fn == nil {
		return fmt.Errorf("replay callback is required")
	}
	return j.ReplayFrom(Cursor{}, fn)
}

// ReplayFrom calls fn for every event after cursor, in order. Events are read in batches, so fn may
// append to the journal; events it appends are replayed too.
func (j *Journal) ReplayFrom(cursor Cursor, fn func(Record) error) error {
	if fn == nil {
		return fmt.Errorf("replay callback is required")
	}
	if strings.TrimSpace(cursor.File) != "" {
		return fmt.Errorf("journal cursor names JSONL segment %q; the journal has moved to SQLite, replay from the start", cursor.File)
	}
	if cursor.Seq < 0 {
		return fmt.Errorf("journal cursor seq must be >= 0")
	}
	db, release, err := j.readHandle()
	if err != nil {
		return err
	}
	defer release()
	after := cursor.Seq
	for {
		records, err := readEvents(db, `WHERE seq > ? ORDER BY seq LIMIT ?`, after, replayBatchSize)
		if err != nil {
			return err
		}
		for _, rec := range records {
			if err := fn(rec); err != nil {
				return err
			}
			after = rec.Ref.Seq
		}
		if len(records) < replayBatchSize {
			return nil
		}
	}
}

const eventColumns = `seq, id, time, domain, type, schema_version, trace_id, runtime, target, topic_id, task_id, audience, payload`

func readEvents(db *sql.DB, where string, args ...any) ([]Record, error) {
	rows, err := db.Query(`SELECT `+eventColumns+` FROM journal_events `+where, args...)
	if err != nil {
		return nil, fmt.Errorf("read journal: %w", err)
	}
	defer rows.Close()
	var out []Record
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read journal: %w", err)
	}
	return out, nil
}

func scanRecord(rows *sql.Rows) (Record, error) {
	var (
		seq     int64
		event   Event
		payload []byte
	)
	if err := rows.Scan(&seq, &event.ID, &event.Time, &event.Domain, &event.Type, &event.SchemaVersion,
		&event.Trace.TraceID, &event.Trace.Runtime, &event.Trace.Target, &event.Trace.TopicID, &event.Trace.TaskID,
		&event.Audience, &payload); err != nil {
		return Record{}, fmt.Errorf("read journal event: %w", err)
	}
	raw, err := decompress(payload)
	if err != nil {
		return Record{}, fmt.Errorf("journal event %d: decompress payload: %w", seq, err)
	}
	event.Payload = raw
	return Record{Cursor: Cursor{Seq: seq}, Ref: RecordRef{Seq: seq}, Event: event}, nil
}

func ReplayDir(dir string, fn func(Record) error) error {
	if fn == nil {
		return fmt.Errorf("replay callback is required")
	}
	j, ok, err := openDir(dir)
	if err != nil || !ok {
		return err
	}
	defer func() { _ = j.Close() }()
	return j.Replay(fn)
}

func ReadAtDir(dir string, ref RecordRef) (Record, error) {
	j, ok, err := openDir(dir)
	if err != nil {
		return Record{}, err
	}
	if !ok {
		return Record{}, fmt.Errorf("journal event %d not found", ref.Seq)
	}
	defer func() { _ = j.Close() }()
	return j.ReadAt(ref)
}

func ReadIndexDir(dir string, kind string, key string, limit int) ([]IndexRecord, error) {
	j, ok, err := openDir(dir)
	if err != nil {
		return nil, err
	}
	if !ok {
		if err := validateIndexQuery(kind, key); err != nil {
			return nil, err
		}
		return nil, nil
	}
	defer func() { _ = j.Close() }()
	return j.ReadIndex(kind, key, limit)
}

func (j *Journal) Close() error {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil
	}
	j.closed = true
	return j.db.Close()
}

func ValidateEvent(event Event) error {
	if err := validateRequiredCanonicalString("id", event.ID); err != nil {
		return err
	}
	if err := validateRequiredCanonicalString("time", event.Time); err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339Nano, event.Time); err != nil {
		return fmt.Errorf("time must be RFC3339")
	}
	if err := validateRequiredCanonicalString("domain", event.Domain); err != nil {
		return err
	}
	if err := validateRequiredCanonicalString("type", event.Type); err != nil {
		return err
	}
	if event.SchemaVersion <= 0 {
		return fmt.Errorf("schema_version must be >= 1")
	}
	if len(event.Payload) == 0 {
		return fmt.Errorf("payload is required")
	}
	if !json.Valid(event.Payload) {
		return fmt.Errorf("payload must be valid JSON")
	}
	return nil
}

func (j *Journal) ReadAt(ref RecordRef) (Record, error) {
	if ref.Seq <= 0 {
		return Record{}, fmt.Errorf("journal record ref seq must be >= 1")
	}
	db, release, err := j.readHandle()
	if err != nil {
		return Record{}, err
	}
	defer release()
	records, err := readEvents(db, `WHERE seq = ?`, ref.Seq)
	if err != nil {
		return Record{}, err
	}
	if len(records) == 0 {
		return Record{}, fmt.Errorf("journal event %d not found", ref.Seq)
	}
	return records[0], nil
}

// ReadIndex returns the last limit events of a task or topic, oldest first.
func (j *Journal) ReadIndex(kind string, key string, limit int) ([]IndexRecord, error) {
	kind = strings.TrimSpace(kind)
	key = strings.TrimSpace(key)
	if err := validateIndexQuery(kind, key); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	db, release, err := j.readHandle()
	if err != nil {
		return nil, err
	}
	defer release()
	column := "task_id"
	if kind == "topic" {
		column = "topic_id"
	}
	rows, err := db.Query(`SELECT seq FROM (SELECT seq FROM journal_events WHERE `+column+` = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`, key, limit)
	if err != nil {
		return nil, fmt.Errorf("read journal index: %w", err)
	}
	defer rows.Close()
	out := make([]IndexRecord, 0, limit)
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			return nil, fmt.Errorf("read journal index: %w", err)
		}
		out = append(out, IndexRecord{Key: key, Ref: RecordRef{Seq: seq}})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read journal index: %w", err)
	}
	return out, nil
}

func validateIndexQuery(kind, key string) error {
	kind = strings.TrimSpace(kind)
	if kind != "task" && kind != "topic" {
		return fmt.Errorf("journal index kind %q is invalid", kind)
	}
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("journal index key is required")
	}
	return nil
}

func compress(raw []byte) ([]byte, error) {
	var buf bytes.Buffer
	w, err := flate.NewWriter(&buf, flate.DefaultCompression)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(raw); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func decompress(data []byte) ([]byte, error) {
	r := flate.NewReader(bytes.NewReader(data))
	defer func() { _ = r.Close() }()
	return io.ReadAll(r)
}

// IsSegmentFile reports whether name is a JSONL segment of the journal before it moved to SQLite.
func IsSegmentFile(name string) bool {
	_, ok := segmentIndex(name)
	return ok
}

func segmentIndex(name string) (int64, bool) {
	if !strings.HasPrefix(name, segmentPrefix) || !strings.HasSuffix(name, segmentSuffix) {
		return 0, false
	}
	raw := strings.TrimSuffix(strings.TrimPrefix(name, segmentPrefix), segmentSuffix)
	if len(raw) != 18 {
		return 0, false
	}
	idx, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || idx <= 0 {
		return 0, false
	}
	return idx, true
}

func validateRequiredCanonicalString(field, value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("%s is required", field)
	}
	if trimmed != value {
		return fmt.Errorf("%s must not contain leading/trailing spaces", field)
	}
	return nil
}

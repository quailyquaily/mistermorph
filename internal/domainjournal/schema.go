package domainjournal

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
)

const schemaSQL = `
CREATE TABLE journal_events (
	seq            INTEGER PRIMARY KEY,
	id             TEXT    NOT NULL,
	time           TEXT    NOT NULL,
	at_ms          INTEGER NOT NULL,
	domain         TEXT    NOT NULL,
	type           TEXT    NOT NULL,
	schema_version INTEGER NOT NULL,
	trace_id       TEXT    NOT NULL DEFAULT '',
	runtime        TEXT    NOT NULL DEFAULT '',
	target         TEXT    NOT NULL DEFAULT '',
	topic_id       TEXT    NOT NULL DEFAULT '',
	task_id        TEXT    NOT NULL DEFAULT '',
	audience       TEXT    NOT NULL DEFAULT '',
	text           TEXT    NOT NULL DEFAULT '',
	payload        BLOB    NOT NULL
);
CREATE INDEX journal_events_id ON journal_events (id);
CREATE INDEX journal_events_task ON journal_events (task_id) WHERE task_id != '';
CREATE INDEX journal_events_topic ON journal_events (topic_id) WHERE topic_id != '';
CREATE INDEX journal_events_kind ON journal_events (domain, type);
CREATE INDEX journal_events_audience ON journal_events (audience, at_ms);
CREATE INDEX journal_events_at ON journal_events (at_ms);

CREATE VIRTUAL TABLE journal_text USING fts5 (
	text,
	content = 'journal_events',
	content_rowid = 'seq',
	tokenize = 'trigram'
);
-- Events are never updated or deleted, so inserting is the only change the index follows.
CREATE TRIGGER journal_events_text AFTER INSERT ON journal_events WHEN new.text != '' BEGIN
	INSERT INTO journal_text (rowid, text) VALUES (new.seq, new.text);
END;

CREATE TABLE journal_import_rejects (
	file  TEXT    NOT NULL,
	line  INTEGER NOT NULL,
	error TEXT    NOT NULL,
	raw   BLOB    NOT NULL,
	PRIMARY KEY (file, line)
);
`

func migrations(dir string) []sqlitedb.Migration {
	return []sqlitedb.Migration{
		{Name: "create journal", SQL: schemaSQL},
		{Name: "import JSONL segments", Apply: func(ctx context.Context, tx *sql.Tx) error {
			return importSegments(ctx, tx, dir)
		}},
	}
}

// importSegments copies the JSONL segments an older version wrote into the database, in order. It
// runs once, as a migration step, so it is atomic and a second process opening the journal waits
// for it. A line that does not decode or validate is kept in journal_import_rejects rather than
// stopping the import: the runtime must still start, and nothing in the journal may be lost. The
// segment files are left on disk.
func importSegments(ctx context.Context, tx *sql.Tx, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var files []string
	for _, entry := range entries {
		if !entry.IsDir() && IsSegmentFile(entry.Name()) {
			files = append(files, entry.Name())
		}
	}
	sort.Slice(files, func(i, k int) bool {
		left, _ := segmentIndex(files[i])
		right, _ := segmentIndex(files[k])
		return left < right
	})
	for _, name := range files {
		if err := importSegment(ctx, tx, filepath.Join(dir, name), name); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

func importSegment(ctx context.Context, tx *sql.Tx, path, name string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	reader := bufio.NewReaderSize(file, 64*1024)
	var line int64
	for {
		raw, readErr := reader.ReadBytes('\n')
		if readErr != nil && readErr != io.EOF {
			return readErr
		}
		if len(raw) > 0 {
			line++
			if trimmed := bytes.TrimSpace(raw); len(trimmed) > 0 {
				if err := importLine(ctx, tx, name, line, trimmed); err != nil {
					return err
				}
			}
		}
		if readErr == io.EOF {
			return nil
		}
	}
}

func importLine(ctx context.Context, tx *sql.Tx, name string, line int64, raw []byte) error {
	var event Event
	err := json.Unmarshal(raw, &event)
	if err == nil {
		err = ValidateEvent(event)
	}
	if err != nil {
		_, insertErr := tx.ExecContext(ctx, `INSERT INTO journal_import_rejects (file, line, error, raw) VALUES (?, ?, ?, ?)`,
			name, line, err.Error(), raw)
		return insertErr
	}
	_, err = insertEvent(ctx, tx, event)
	return err
}

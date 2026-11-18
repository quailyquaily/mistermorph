package cron

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// JobIDPrefix starts every job ID this version makes: "job-" and a random (version 4) UUID. The ID
// names the job alone; it says nothing about what starts its runs (a schedule today; a webhook or
// a mention could later), so any trigger can use the same form. IDs an earlier version made
// ("cron-<uuid>", the Console's "task-<n>", or one a person chose) stay valid as they are.
const JobIDPrefix = "job-"

var jobIDPattern = regexp.MustCompile(`^job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// NewJobID returns a new job ID: "job-" and a random UUID, in lower case.
func NewJobID() string {
	return JobIDPrefix + uuid.New().String()
}

// IsGeneratedJobID reports whether id has the form NewJobID makes. It is false for the legacy
// IDs, which are still valid job IDs.
func IsGeneratedJobID(id string) bool {
	return jobIDPattern.MatchString(strings.TrimSpace(id))
}

// nowText is the current time as jobs.db stores times: RFC 3339 in UTC, to the second.
func nowText() string {
	return formatTime(time.Now())
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

type metaQueryer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func setMeta(ctx context.Context, q metaQueryer, key string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, string(data))
	return err
}

func getMeta(ctx context.Context, q metaQueryer, key string, value any) (bool, error) {
	var raw string
	err := q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal([]byte(raw), value)
}

func readRevision(ctx context.Context, q metaQueryer) (int64, error) {
	var raw string
	err := q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, jobsRevisionKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
}

// bumpRevision counts one change to the list, in the change's transaction.
func bumpRevision(ctx context.Context, q metaQueryer) error {
	current, err := readRevision(ctx, q)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, jobsRevisionKey, strconv.FormatInt(current+1, 10))
	return err
}

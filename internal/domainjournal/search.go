package domainjournal

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// OwnerAudience is the owner's audience. Events with no audience belong to it.
const OwnerAudience = "owner"

const (
	defaultSearchLimit = 20
	maxSearchLimit     = 100
	// minTrigramRunes is the shortest term the trigram index can match. Shorter terms, such as a
	// two-character CJK word, are matched with LIKE over the same text.
	minTrigramRunes = 3
)

// SearchOptions selects journal events by what people said in them.
type SearchOptions struct {
	// Query is matched as words, all of which must appear. Empty matches every event with text.
	Query string
	// Audiences are the audiences whose events the caller may hear. An event with an empty
	// audience belongs to the owner. Nothing matches when Audiences is empty and AllAudiences is
	// false.
	Audiences []string
	// AllAudiences lets the owner hear every event.
	AllAudiences bool
	Since        time.Time
	Until        time.Time
	Domain       string
	// Limit defaults to 20 and is at most 100. Results are newest first.
	Limit int
}

// SearchHit is one matching event, with the text that was indexed for it.
type SearchHit struct {
	Ref      RecordRef
	ID       string
	Time     string
	Domain   string
	Type     string
	Trace    Trace
	Audience string
	Text     string
}

func (j *Journal) Search(opts SearchOptions) ([]SearchHit, bool, error) {
	db, release, err := j.readHandle()
	if err != nil {
		return nil, false, err
	}
	defer release()
	if !opts.AllAudiences && len(opts.Audiences) == 0 {
		return nil, false, nil
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxSearchLimit {
		limit = maxSearchLimit
	}

	where := []string{`e.text != ''`}
	var args []any
	var matchTerms []string
	for _, term := range strings.Fields(opts.Query) {
		if utf8.RuneCountInString(term) >= minTrigramRunes {
			matchTerms = append(matchTerms, `"`+strings.ReplaceAll(term, `"`, `""`)+`"`)
			continue
		}
		where = append(where, `e.text LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(term)+"%")
	}
	if len(matchTerms) > 0 {
		where = append(where, `e.seq IN (SELECT rowid FROM journal_text WHERE journal_text MATCH ?)`)
		args = append(args, strings.Join(matchTerms, " "))
	}
	if !opts.AllAudiences {
		placeholders := make([]string, 0, len(opts.Audiences))
		for _, audience := range opts.Audiences {
			audience = strings.TrimSpace(audience)
			placeholders = append(placeholders, "?")
			args = append(args, audience)
			if audience == OwnerAudience {
				placeholders = append(placeholders, "?")
				args = append(args, "")
			}
		}
		where = append(where, `e.audience IN (`+strings.Join(placeholders, ", ")+`)`)
	}
	if !opts.Since.IsZero() {
		where = append(where, `e.at_ms >= ?`)
		args = append(args, opts.Since.UnixMilli())
	}
	if !opts.Until.IsZero() {
		where = append(where, `e.at_ms < ?`)
		args = append(args, opts.Until.UnixMilli())
	}
	if domain := strings.TrimSpace(opts.Domain); domain != "" {
		where = append(where, `e.domain = ?`)
		args = append(args, domain)
	}
	// One more than the limit says whether there is more.
	args = append(args, limit+1)
	rows, err := db.Query(`SELECT e.seq, e.id, e.time, e.domain, e.type, e.trace_id, e.runtime, e.target, e.topic_id, e.task_id, e.audience, e.text
		FROM journal_events e WHERE `+strings.Join(where, " AND ")+` ORDER BY e.seq DESC LIMIT ?`, args...)
	if err != nil {
		return nil, false, fmt.Errorf("search journal: %w", err)
	}
	defer rows.Close()
	var hits []SearchHit
	for rows.Next() {
		var hit SearchHit
		if err := rows.Scan(&hit.Ref.Seq, &hit.ID, &hit.Time, &hit.Domain, &hit.Type,
			&hit.Trace.TraceID, &hit.Trace.Runtime, &hit.Trace.Target, &hit.Trace.TopicID, &hit.Trace.TaskID,
			&hit.Audience, &hit.Text); err != nil {
			return nil, false, fmt.Errorf("search journal: %w", err)
		}
		hits = append(hits, hit)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("search journal: %w", err)
	}
	more := len(hits) > limit
	if more {
		hits = hits[:limit]
	}
	return hits, more, nil
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

package agentdb

import (
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
)

// The schema of agent.db, in the order it was added. A released step never changes: add a new one.
func migrations() []sqlitedb.Migration {
	return []sqlitedb.Migration{
		{Name: "create meta, Console sessions, Agent Link peers and topic state", SQL: stateimport.MetaTableSQL + smallStateSQL},
	}
}

// smallStateSQL: Console sessions, Agent Link peers, topic state (§4 to §6 of the design).
const smallStateSQL = `
CREATE TABLE console_sessions (
	token_hash TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
CREATE INDEX console_sessions_by_expiry ON console_sessions (expires_at);

CREATE TABLE agentlink_peers (
	instance_id TEXT PRIMARY KEY,
	agent_name  TEXT NOT NULL DEFAULT '',
	last_seen   TEXT NOT NULL
);

CREATE TABLE topic_contexts (
	conversation_key            TEXT PRIMARY KEY,
	topic_id                    TEXT NOT NULL DEFAULT '',
	runtime                     TEXT NOT NULL DEFAULT '',
	model                       TEXT NOT NULL DEFAULT '',
	normalized_model            TEXT NOT NULL DEFAULT '',
	context_window_tokens       INTEGER NOT NULL DEFAULT 0,
	context_window_source       TEXT NOT NULL DEFAULT '',
	used_input_tokens           INTEGER NOT NULL DEFAULT 0,
	cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
	cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
	usage_ratio                 REAL NOT NULL DEFAULT 0,
	last_run_id                 TEXT NOT NULL DEFAULT '',
	last_origin_event_id        TEXT NOT NULL DEFAULT '',
	updated_at                  TEXT NOT NULL
);
CREATE INDEX topic_contexts_by_topic ON topic_contexts (topic_id) WHERE topic_id != '';

CREATE TABLE topic_context_snapshots (
	conversation_key TEXT PRIMARY KEY,
	topic_id         TEXT NOT NULL DEFAULT '',
	run_id           TEXT NOT NULL DEFAULT '',
	model            TEXT NOT NULL DEFAULT '',
	captured_at      TEXT NOT NULL,
	snapshot         TEXT NOT NULL,
	request          BLOB
);
CREATE INDEX topic_context_snapshots_by_topic ON topic_context_snapshots (topic_id) WHERE topic_id != '';

CREATE TABLE workspace_attachments (
	scope_key     TEXT PRIMARY KEY,
	workspace_dir TEXT NOT NULL,
	updated_at    TEXT NOT NULL
);
`

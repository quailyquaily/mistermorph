package agentdb

import (
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
)

// The schema of agent.db, in the order it was added. A released step never changes: add a new one.
func migrations() []sqlitedb.Migration {
	return []sqlitedb.Migration{
		{Name: "create meta, Console sessions, Agent Link peers and topic state", SQL: stateimport.MetaTableSQL + smallStateSQL},
		{Name: "create identity and heartbeat workflows", SQL: personaSQL},
		{Name: "create cron tasks", SQL: cronSQL},
		{Name: "create contacts and the contacts bus inbox and outbox", SQL: contactsSQL},
		{Name: "create the config tables", SQL: configSQL},
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

// personaSQL: the identity, soul included, and the heartbeat workflows (§1).
const personaSQL = `
CREATE TABLE identity (
	id         INTEGER PRIMARY KEY CHECK (id = 1),
	name       TEXT NOT NULL DEFAULT '',
	name_alts  TEXT NOT NULL DEFAULT '[]',
	creature   TEXT NOT NULL DEFAULT '',
	vibe       TEXT NOT NULL DEFAULT '',
	emoji      TEXT NOT NULL DEFAULT '',
	soul       TEXT NOT NULL DEFAULT '',
	extra      TEXT NOT NULL DEFAULT '{}',
	updated_at TEXT NOT NULL,
	updated_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE heartbeat_workflows (
	id           TEXT PRIMARY KEY,
	position     INTEGER NOT NULL,
	title        TEXT NOT NULL,
	instructions TEXT NOT NULL,
	enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at   TEXT NOT NULL,
	updated_at   TEXT NOT NULL
);
CREATE INDEX heartbeat_workflows_by_position ON heartbeat_workflows (position);
`

// cronSQL: the TODO list (§3).
const cronSQL = `
CREATE TABLE cron_tasks (
	id              TEXT PRIMARY KEY,
	position        INTEGER NOT NULL,
	title           TEXT NOT NULL DEFAULT '',
	enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	at              TEXT NOT NULL DEFAULT '',
	cron            TEXT NOT NULL DEFAULT '',
	tz              TEXT NOT NULL DEFAULT '',
	content         TEXT NOT NULL,
	chat_id         TEXT NOT NULL DEFAULT '',
	mention         TEXT NOT NULL DEFAULT '',
	llm_profile     TEXT NOT NULL DEFAULT '',
	workspace_dir   TEXT NOT NULL DEFAULT '',
	bash_env        TEXT NOT NULL DEFAULT '[]',
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL,
	last_run_at     TEXT,
	last_run_status TEXT NOT NULL DEFAULT '',
	CHECK ((at = '') <> (cron = ''))
);
CREATE INDEX cron_tasks_by_position ON cron_tasks (position);
`

// contactsSQL: contacts, their channel handles, and the bus inbox and outbox (§2).
const contactsSQL = `
CREATE TABLE contacts (
	contact_id          TEXT PRIMARY KEY,
	status              TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
	kind                TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
	channel             TEXT NOT NULL DEFAULT '',
	nickname            TEXT NOT NULL DEFAULT '',
	paired              INTEGER NOT NULL DEFAULT 0 CHECK (paired IN (0, 1)),
	owner               INTEGER NOT NULL DEFAULT 0 CHECK (owner IN (0, 1)),
	deactivated_by      TEXT NOT NULL DEFAULT '',
	cooldown_until      TEXT,
	last_interaction_at TEXT,
	created_at          TEXT NOT NULL,
	updated_at          TEXT NOT NULL
);
CREATE INDEX contacts_by_status ON contacts (status, last_interaction_at DESC);
CREATE INDEX contacts_by_kind ON contacts (kind) WHERE status = 'active';

CREATE TABLE contact_handles (
	contact_id TEXT NOT NULL REFERENCES contacts (contact_id) ON DELETE CASCADE,
	field      TEXT NOT NULL,
	value      TEXT NOT NULL,
	position   INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (contact_id, field, value)
);
CREATE INDEX contact_handles_lookup ON contact_handles (field, value);

CREATE TABLE contact_bus_inbox (
	channel             TEXT NOT NULL,
	platform_message_id TEXT NOT NULL,
	conversation_key    TEXT NOT NULL DEFAULT '',
	seen_at             TEXT NOT NULL,
	PRIMARY KEY (channel, platform_message_id)
);
CREATE INDEX contact_bus_inbox_by_seen ON contact_bus_inbox (seen_at);

CREATE TABLE contact_bus_outbox (
	channel         TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	contact_id      TEXT NOT NULL DEFAULT '',
	peer_id         TEXT NOT NULL DEFAULT '',
	item_id         TEXT NOT NULL DEFAULT '',
	content_type    TEXT NOT NULL DEFAULT '',
	payload         BLOB,
	file            TEXT,
	status          TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
	attempts        INTEGER NOT NULL DEFAULT 0,
	accepted        INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
	deduped         INTEGER NOT NULL DEFAULT 0 CHECK (deduped IN (0, 1)),
	last_error      TEXT NOT NULL DEFAULT '',
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL,
	last_attempt_at TEXT,
	sent_at         TEXT,
	PRIMARY KEY (channel, idempotency_key)
);
CREATE INDEX contact_bus_outbox_pending ON contact_bus_outbox (status, updated_at) WHERE status = 'pending';
`

// configSQL: the config (§7).
const configSQL = `
CREATE TABLE settings (
	path       TEXT PRIMARY KEY,
	kind       TEXT NOT NULL CHECK (kind IN ('string', 'duration', 'bool', 'int', 'float',
	                                          'string_list', 'string_map', 'json')),
	value      TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	updated_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE llm_profiles (
	name                    TEXT PRIMARY KEY,
	position                INTEGER NOT NULL,
	description             TEXT NOT NULL DEFAULT '',
	abilities               TEXT NOT NULL DEFAULT '[]',
	inference_provider      TEXT NOT NULL DEFAULT '',
	provider                TEXT NOT NULL DEFAULT '',
	endpoint                TEXT NOT NULL DEFAULT '',
	api_key                 TEXT NOT NULL DEFAULT '',
	model                   TEXT NOT NULL DEFAULT '',
	supports_image_parts    INTEGER CHECK (supports_image_parts IN (0, 1)),
	context_window_tokens   INTEGER,
	headers                 TEXT NOT NULL DEFAULT '{}',
	cache_ttl               TEXT NOT NULL DEFAULT '',
	cache_key_prefix        TEXT NOT NULL DEFAULT '',
	request_timeout         TEXT NOT NULL DEFAULT '',
	tools_emulation_mode    TEXT NOT NULL DEFAULT '',
	temperature             REAL,
	reasoning_effort        TEXT NOT NULL DEFAULT '',
	reasoning_budget_tokens INTEGER,
	provider_options        TEXT NOT NULL DEFAULT '{}',
	updated_at              TEXT NOT NULL,
	updated_by              TEXT NOT NULL DEFAULT ''
);

CREATE TABLE llm_routes (
	purpose           TEXT PRIMARY KEY CHECK (purpose IN ('main_loop', 'decision', 'addressing', 'awareness',
	                                                     'heartbeat', 'think', 'plan_create', 'image',
	                                                     'transcription')),
	profile           TEXT NOT NULL DEFAULT '',
	fallback_profiles TEXT NOT NULL DEFAULT '[]',
	updated_at        TEXT NOT NULL,
	updated_by        TEXT NOT NULL DEFAULT ''
);
CREATE TABLE llm_route_candidates (
	purpose  TEXT NOT NULL REFERENCES llm_routes (purpose) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	profile  TEXT NOT NULL,
	weight   INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
	PRIMARY KEY (purpose, position)
);

CREATE TABLE mcp_servers (
	name          TEXT PRIMARY KEY,
	position      INTEGER NOT NULL,
	enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	on_demand     INTEGER NOT NULL DEFAULT 0 CHECK (on_demand IN (0, 1)),
	description   TEXT NOT NULL DEFAULT '',
	type          TEXT NOT NULL DEFAULT 'stdio' CHECK (type IN ('stdio', 'http')),
	command       TEXT NOT NULL DEFAULT '',
	args          TEXT NOT NULL DEFAULT '[]',
	env           TEXT NOT NULL DEFAULT '{}',
	url           TEXT NOT NULL DEFAULT '',
	headers       TEXT NOT NULL DEFAULT '{}',
	allowed_tools TEXT NOT NULL DEFAULT '[]',
	updated_at    TEXT NOT NULL,
	updated_by    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE console_endpoints (
	name       TEXT PRIMARY KEY,
	position   INTEGER NOT NULL,
	url        TEXT NOT NULL,
	auth_token TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL,
	updated_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE auth_profiles (
	name              TEXT PRIMARY KEY,
	credential_kind   TEXT NOT NULL DEFAULT '',
	credential_secret TEXT NOT NULL DEFAULT '',
	allow             TEXT NOT NULL DEFAULT '{}',
	bindings          TEXT NOT NULL DEFAULT '{}',
	updated_at        TEXT NOT NULL,
	updated_by        TEXT NOT NULL DEFAULT ''
);
`

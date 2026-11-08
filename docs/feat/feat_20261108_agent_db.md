---
date: 2026-11-08
title: agent.db and usage.db, the agent's state in SQLite
status: implemented
---

# agent.db and usage.db, the agent's state in SQLite

## Goal

Most of the agent's state is in files that the code treats as a database: Markdown files parsed into contact
records, a YAML file rewritten whole for every TODO change, JSON files rewritten whole on every login or LLM step.
Each store has its own lock files, atomic-rename writes, parsing and repair code, and two of them have no lock
between processes at all.

Move that state into SQLite, next to the two databases that are already there:

```
<file_state_dir>/
├── journal/journal.db   existing: task and topic events
├── memory.db            existing: memories
├── agent.db             new: config, persona, contacts, TODO (cron), Console sessions, Agent Link peers, topic state
└── usage.db             new: LLM usage
```

`usage.db` is its own file because it is written on every model call, grows without bound, and losing it loses
only numbers; it gets its own retention and can be left out of a backup. Everything else that makes this agent this
agent goes into `agent.db`.

Stays a file: logs (JSONL), the guard audit log (JSONL), `persona/avatar.webp`, contact avatars
(`contacts/avatars/`). Images are served as they are and are not queried. A config file named with `--config`
stays a file too (§7).

## What is wrong today

1. **No lock where several processes write.** Every wrapped LLM client opens its own handle on the usage journal
   (`internal/llmstats/client.go:59,80,260`) and appends without a lock between processes. `sessions.json` and
   `peers.json` have only an in-process mutex.
2. **Whole-file rewrites for one change.** Contacts (`contacts/file_store.go`), `cron.yaml`, `sessions.json` and
   `peers.json` are read, changed and rewritten whole for every update. `peers.json` is rewritten every 10 minutes
   even when nothing changed.
3. **Lookups by scanning.** Contacts have one key (`contact_id`); finding a contact by a Telegram chat ID or a Slack
   user ID lists every contact and filters in memory (`service.go:299`, `bus_observe.go`).
4. **Derived data with rebuild logic.** `stats/llm_usage_projection.json` keeps byte offsets into the journal and
   rebuilds on a pricing change, a schema change or a moved file. The daily chart skips it and rescans the JSONL
   segments on every request.
5. **Editing paths that skip the lock.** The Console's raw file endpoints (`/contacts/files/*`, `/todo/files/*`,
   `/persona/files/*`, `/state/files/HEARTBEAT.md`) overwrite whole files without the stores' locks.
6. **Many small files.** One folder per conversation under `topics/` (58 on a live install) for three or four JSON
   files each; a `.lck` per store, per topic and per scheduler.

## Principles

- **Same behaviour, new storage.** Prompts, tools, the Console and the channels see the same data. Where the
  storage was the interface (the agent reading `ACTIVE.md` with `read_file`, the Console editing raw files), the
  interface is replaced, not removed (see Agent and Console access).
- **Fields are columns; prose is a column too.** The config, the identity and the heartbeat checklist are
  structured data and get tables with a column per field. Where the content is writing the model reads (the soul,
  a heartbeat workflow's instructions), that writing is one Markdown column beside the fields around it (the
  identity's name, a workflow's title and on/off switch). `${VAR}` and secret references are kept as written and expanded when read.
- **Columns for what is queried, JSON for the rest.** Lookups, filters and sorts get columns and indexes; nested
  data nobody queries (`bash_env`, a context snapshot's parts) is a JSON text column.
- **One transaction per change.** No lock files for these stores: SQLite's write lock replaces them.
- **The files are imported once and kept.** Each old file is imported on first open, then renamed to
  `<name>.imported`, never deleted by the import. The config's open (before the config is loaded) runs no imports:
  they run on the next open, so an import that depends on a setting (the contacts folder's `contacts.dir_name`)
  sees the configured value.

## Conventions

- Opened with `internal/sqlitedb` (WAL, `BEGIN IMMEDIATE`, owner-only mode 0600, migrations in `PRAGMA
  user_version`), as `memory.db` and `journal.db` are. Paths are constants in `internal/statepaths`
  (`AgentDBFilename = "agent.db"`, `UsageDBFilename = "usage.db"`) beside `MemoryDBFilename`.
- `agent.db` uses `Durable: true` (synchronous=FULL): it holds the agent's identity and contacts. `usage.db` uses
  the default (NORMAL).
- Times in `agent.db` are RFC 3339 UTC text, as in `memory.db`. Times in `usage.db` are Unix milliseconds
  (`INTEGER`), because its queries are ranges and buckets over many rows.
- Booleans are `INTEGER NOT NULL DEFAULT 0` with a `CHECK (x IN (0, 1))`.
- Each database has a `meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)` table for import marks and settings such
  as the pricing digest.

## Design: agent.db

### 1. Persona and heartbeat

```sql
-- identity.yaml and soul.md: one row.
CREATE TABLE identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT NOT NULL DEFAULT '',
  name_alts  TEXT NOT NULL DEFAULT '[]',   -- JSON list of strings
  creature   TEXT NOT NULL DEFAULT '',
  vibe       TEXT NOT NULL DEFAULT '',
  emoji      TEXT NOT NULL DEFAULT '',
  soul       TEXT NOT NULL DEFAULT '',     -- the soul: Markdown the model reads, '' for none
  extra      TEXT NOT NULL DEFAULT '{}',   -- keys an owner added to identity.yaml beyond these, as a JSON object
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''      -- 'console', 'install', 'import', 'cli'
);

-- HEARTBEAT.md: one row per workflow the heartbeat checks.
CREATE TABLE heartbeat_workflows (
  id           TEXT PRIMARY KEY,           -- 'hb-<uuid>'
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,              -- was the '## ' heading
  instructions TEXT NOT NULL,              -- Markdown: the steps under the heading
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

- **Identity.** The five fields the template and `morph install` write are columns; `personautil.LoadAgentName`
  reads `name`. An identity file with other keys keeps them in `extra`. The prompt keeps its `[identity.yaml]` block:
  `promptprofile.ApplyPersonaIdentity` renders it from the row as YAML, in the same shape the file had.
- **Soul.** A text field of the identity: Markdown the model reads whole, without front matter. Its headings
  ("Core Truths", "Boundaries") are the author's prose, not fields any code reads. An empty soul is left out of the
  prompt, as a missing `soul.md` is today; a soul whose front matter said `status: draft` (left out of the prompt
  today) is imported as empty, and the original stays in `soul.md.imported`.
- **Heartbeat.** A checklist file of `## ` sections becomes rows, so a workflow can be switched off without deleting
  it, and the Console can list, reorder and edit them one at a time. Each tick renders the enabled workflows as
  `## <title>` followed by the instructions, in order; with none enabled there is no heartbeat task, as an empty
  checklist does today. The heartbeat's schedule stays in the config (`heartbeat.*`, §7).
- `promptprofile` and the heartbeat read these rows per run and per tick, uncached, as they read the files now.

### 2. Contacts

```sql
CREATE TABLE contacts (
  contact_id          TEXT PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  kind                TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  channel             TEXT NOT NULL DEFAULT '',
  nickname            TEXT NOT NULL DEFAULT '',
  paired              INTEGER NOT NULL DEFAULT 0 CHECK (paired IN (0, 1)),
  owner               INTEGER NOT NULL DEFAULT 0 CHECK (owner IN (0, 1)),
  deactivated_by      TEXT NOT NULL DEFAULT '',   -- '', 'agentlink_sync', 'active_limit'
  cooldown_until      TEXT,
  last_interaction_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX contacts_by_status ON contacts (status, last_interaction_at DESC);
CREATE INDEX contacts_by_kind ON contacts (kind) WHERE status = 'active';

-- Every channel identifier of a contact: one row per value, so a lookup by any of them is an index seek.
CREATE TABLE contact_handles (
  contact_id TEXT NOT NULL REFERENCES contacts (contact_id) ON DELETE CASCADE,
  field      TEXT NOT NULL,     -- the Contact field name: tg_user_id, tg_group_chat_ids, slack_user_id, ...
  value      TEXT NOT NULL,     -- as text (Telegram IDs too, as in the Markdown today)
  position   INTEGER NOT NULL DEFAULT 0,   -- order within a list field
  PRIMARY KEY (contact_id, field, value)
);
CREATE INDEX contact_handles_lookup ON contact_handles (field, value);
```

- The `Contact` type does not change. Its single-valued channel fields (`tg_user_id`, `slack_user_id`,
  `discord_dm_channel_id`, ...) and list fields (`tg_group_chat_ids`, `line_chat_ids`, `slack_channel_ids`, ...)
  are rows of `contact_handles`; the store maps them both ways. A new channel adds a field name, not a column.
- Group chat IDs are shared by many contacts, so `(field, value)` is not unique; single-valued fields are unique
  per contact by the primary key.
- **Active vs inactive** is the `status` column instead of the file a contact is in. The limit of 150 active
  contacts (`maxActiveContacts`) stays: a write that goes over it moves the contacts with the oldest
  `last_interaction_at` to `inactive` with `deactivated_by = 'active_limit'`, in the same transaction.
- **Agent Link's own deactivation** (`peers.json`'s `deactivated_by_sync`) becomes `deactivated_by =
  'agentlink_sync'`, so the sync reactivates only the contacts it deactivated.
- **Legacy profile fields** (`persona_brief`, `topic_preferences`) are not carried over: the import first runs
  `memories.MoveContactProfiles`, which turns them into memories, as it does today.

```sql
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
  payload         BLOB,                         -- was payload_base64
  file            TEXT,                         -- ShareFile as JSON {path, filename, size, sha256}
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
```

These were `bus_inbox.json` and `bus_outbox.json` in the contacts folder, rewritten whole per message.

### 3. TODO (cron)

```sql
CREATE TABLE cron_tasks (
  id            TEXT PRIMARY KEY,               -- 'cron-<uuid>' when generated
  position      INTEGER NOT NULL,               -- the list's order (the Console replaces the whole list)
  title         TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  at            TEXT NOT NULL DEFAULT '',       -- one-time: '2006-01-02 15:04' in tz
  cron          TEXT NOT NULL DEFAULT '',       -- recurring: 5 numeric fields
  tz            TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  chat_id       TEXT NOT NULL DEFAULT '',
  mention       TEXT NOT NULL DEFAULT '',
  llm_profile   TEXT NOT NULL DEFAULT '',
  workspace_dir TEXT NOT NULL DEFAULT '',
  bash_env      TEXT NOT NULL DEFAULT '[]',     -- [{name, value}] as JSON
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_run_at     TEXT,                         -- new: when the scheduler last started it
  last_run_status TEXT NOT NULL DEFAULT '',     -- new: '', 'done', 'failed'
  CHECK ((at = '') <> (cron = ''))
);
```

- `internal/cron`'s `File` and `Task` types stay; `Store` reads and writes rows. Validation is unchanged
  (`schedule.go`, `todo.ExtractReferenceIDs`), and `PUT /todo/tasks` replaces the list in one transaction.
- The topic stays derived: `_cron_<id>`. Run history stays where it is (tasks in the journal's console store).
- The heartbeat stays a built-in task that is never stored (`__heartbeat__`).
- `last_run_at` and `last_run_status` are new: nothing records a run today, and a one-time task that fails is
  retried on every tick with no trace. The Console's TODO list can show them; the retry behaviour itself does not
  change in this work.
- **The scheduler lock stays a file lock** (`<state>/locks/cron.scheduler.lck`, was `cron.yaml.scheduler.lck`): it
  is held for a process's lifetime so only one process schedules, and the kernel releases a flock when the process
  dies. A lease row would need heartbeats and expiry for the same guarantee. `cron.yaml.lck` goes away.

### 4. Console sessions

```sql
CREATE TABLE console_sessions (
  token_hash TEXT PRIMARY KEY,    -- hex SHA-256 of the token; the token itself is never stored, as today
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX console_sessions_by_expiry ON console_sessions (expires_at);
```

`Validate` (every authenticated request) becomes a primary-key read; expired rows are deleted on login and once a
minute, not by rewriting a file during a read. The in-memory stream tickets stay in memory.

### 5. Agent Link peers

```sql
CREATE TABLE agentlink_peers (
  instance_id TEXT PRIMARY KEY,
  agent_name  TEXT NOT NULL DEFAULT '',
  last_seen   TEXT NOT NULL
);
```

The 10-minute sync updates only the rows that changed. `deactivated_by_sync` moves to `contacts.deactivated_by`
(§2). `accountdm/<channel>_peers.json` is a different store and is out of scope.

### 6. Topic state

These are the files under `topics/<sha256(conversation_key)[:12]>/`. Rows are keyed by the conversation key
itself, so the hashed folder names go away.

```sql
-- context.json: the conversation's context window use after its latest LLM step.
CREATE TABLE topic_contexts (
  conversation_key            TEXT PRIMARY KEY,
  topic_id                    TEXT NOT NULL DEFAULT '',
  runtime                     TEXT NOT NULL DEFAULT '',
  model                       TEXT NOT NULL DEFAULT '',
  normalized_model            TEXT NOT NULL DEFAULT '',
  context_window_tokens       INTEGER NOT NULL DEFAULT 0,
  context_window_source       TEXT NOT NULL DEFAULT '',   -- config, builtin, unknown
  used_input_tokens           INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  usage_ratio                 REAL NOT NULL DEFAULT 0,
  last_run_id                 TEXT NOT NULL DEFAULT '',
  last_origin_event_id        TEXT NOT NULL DEFAULT '',
  updated_at                  TEXT NOT NULL
);
CREATE INDEX topic_contexts_by_topic ON topic_contexts (topic_id) WHERE topic_id != '';

-- context_snapshot.json and context_request.json: what the latest LLM step sent, for Inspect Context.
CREATE TABLE topic_context_snapshots (
  conversation_key TEXT PRIMARY KEY,
  topic_id         TEXT NOT NULL DEFAULT '',
  run_id           TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT '',
  captured_at      TEXT NOT NULL,
  snapshot         TEXT NOT NULL,     -- topiccontext.Snapshot as JSON (parts with content cut at 16 KiB)
  request          BLOB              -- storedRequest as gzipped JSON; NULL when over the 8 MiB limit
);
CREATE INDEX topic_context_snapshots_by_topic ON topic_context_snapshots (topic_id) WHERE topic_id != '';

-- workspace.json: the folder a conversation's tasks work in.
CREATE TABLE workspace_attachments (
  scope_key     TEXT PRIMARY KEY,
  workspace_dir TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

- The snapshot (70 to 160 KB) and the request (45 to 320 KB seen, up to 8 MiB) are rewritten on every main-loop
  LLM step, as the files are now. The request is stored gzipped (JSON compresses several times over), which also
  keeps the WAL small. If the write volume shows up in profiles, the snapshot tables can move to `usage.db`, which
  is written per call already; the schema does not change.
- Deleting a Console topic deletes its rows in all three tables in one transaction (today `topicstate.Remove`
  removes the folder).
- The per-topic `locks/topic_<key>.lck` files go away; the snapshot write, which never took that lock, is now a
  transaction like the rest.

### 7. Config

The config becomes tables: the named collections (LLM profiles, routes, MCP servers, Console endpoints, auth
profiles) get one table each, and every other value is a row of `settings`, keyed by its path.

```sql
-- Every config value outside the collections below: one row per key path.
CREATE TABLE settings (
  path       TEXT PRIMARY KEY,   -- dotted, as viper reads it: 'llm.request_timeout', 'telegram.allowed_chat_ids'
  kind       TEXT NOT NULL CHECK (kind IN ('string', 'duration', 'bool', 'int', 'float',
                                            'string_list', 'string_map', 'json')),
  value      TEXT NOT NULL,      -- the value as JSON: "90s", true, 8, ["tg:@admin"], {"k": "v"}
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

-- llm.* (the profile named 'default') and llm.profiles.<name>.
CREATE TABLE llm_profiles (
  name                    TEXT PRIMARY KEY,
  position                INTEGER NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  abilities               TEXT NOT NULL DEFAULT '[]',   -- text, decision, image, transcription
  inference_provider      TEXT NOT NULL DEFAULT '',
  provider                TEXT NOT NULL DEFAULT '',
  endpoint                TEXT NOT NULL DEFAULT '',
  api_key                 TEXT NOT NULL DEFAULT '',     -- as written: '${OPENAI_API_KEY}' or a secret reference
  model                   TEXT NOT NULL DEFAULT '',
  supports_image_parts    INTEGER CHECK (supports_image_parts IN (0, 1)),   -- NULL: from the model catalog
  context_window_tokens   INTEGER,                      -- NULL: from the model catalog
  headers                 TEXT NOT NULL DEFAULT '{}',
  cache_ttl               TEXT NOT NULL DEFAULT '',
  cache_key_prefix        TEXT NOT NULL DEFAULT '',
  request_timeout         TEXT NOT NULL DEFAULT '',
  tools_emulation_mode    TEXT NOT NULL DEFAULT '',
  temperature             REAL,
  reasoning_effort        TEXT NOT NULL DEFAULT '',
  reasoning_budget_tokens INTEGER,
  provider_options        TEXT NOT NULL DEFAULT '{}',   -- the azure, bedrock and cloudflare blocks
  updated_at              TEXT NOT NULL,
  updated_by              TEXT NOT NULL DEFAULT ''
);

-- llm.routes.<purpose>: one profile, or weighted candidates, with fallbacks.
CREATE TABLE llm_routes (
  purpose           TEXT PRIMARY KEY CHECK (purpose IN ('main_loop', 'decision', 'addressing', 'awareness',
                                                       'heartbeat', 'think', 'plan_create', 'image',
                                                       'transcription')),
  profile           TEXT NOT NULL DEFAULT '',   -- '' when the route has candidates
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

-- mcp.servers.
CREATE TABLE mcp_servers (
  name          TEXT PRIMARY KEY,               -- [A-Za-z][A-Za-z0-9_-]*
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

-- console.endpoints.
CREATE TABLE console_endpoints (
  name       TEXT PRIMARY KEY,
  position   INTEGER NOT NULL,
  url        TEXT NOT NULL,
  auth_token TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

-- auth_profiles.<name>.
CREATE TABLE auth_profiles (
  name              TEXT PRIMARY KEY,
  credential_kind   TEXT NOT NULL DEFAULT '',   -- api_key, ...
  credential_secret TEXT NOT NULL DEFAULT '',   -- as written: '${VAR}' or a secret reference
  allow             TEXT NOT NULL DEFAULT '{}', -- url_prefixes, methods, follow_redirects, ... as JSON
  bindings          TEXT NOT NULL DEFAULT '{}', -- per tool (url_fetch: inject, header allowlists) as JSON
  updated_at        TEXT NOT NULL,
  updated_by        TEXT NOT NULL DEFAULT ''
);
```

- **`settings` covers the rest**: the 239 fields of the Console's settings registry (`internal/configsettings`), whose
  kinds are the `kind` column, and any key the registry does not know, stored at its path with a kind taken from
  its value, so a config key added later needs no migration.
- **The collections get tables** because each item has a name, an order and fields of its own, and the Console
  edits them one item at a time. Their nested parts nobody filters on (`provider_options`, an auth profile's
  `allow` and `bindings`, an MCP server's `env`) are JSON columns.
- **Secrets stay as written.** A value like `${OPENAI_API_KEY}`, or a reference to a secret kept outside the config
  (`configsettings.ProtectSecrets`, `secref`), is stored as that text and expanded when the config is read, as the
  file's were.

**Where agent.db is.** The config cannot say where the database that holds it is, so `file_state_dir` becomes a
bootstrap setting, resolved before anything is read: `MISTER_MORPH_FILE_STATE_DIR` (it already works, through
viper, and both deploy scripts use it), else `~/.morph`. A new `--state-dir` flag sets the same thing. There is no
`file_state_dir` row.

**Loading** (`loadRootConfig`, `cmd/mistermorph/root.go`) keeps its order: defaults (`configdefaults`), then the
config, then `${VAR}` expansion and the flag overrides, then `MISTER_MORPH_*` environment variables. The config
part builds the same nested map the YAML gave viper: `settings` rows by path, the `default` profile at `llm.*`,
the other profiles under `llm.profiles`, a route as its profile name when it has only that and as an object
otherwise, the servers, endpoints and auth profiles as their lists and maps. Everything that reads viper is
unchanged.

**`--config <path>` keeps meaning "this file is the config".** systemd units, the Cloudflare deploy
(`MISTER_MORPH_CONFIG_YAML` written to a file), CI and the desktop shell all pass a path. With `--config`, the file
is read and the Console's settings are saved back to it, as today; `agent.db` holds no config. Without it, the
config is in `agent.db`. The Console's settings page says which one it is editing.

**Writers.** Everything that rewrites `config.yaml` goes through one interface, `configstore.Store`, with a file
backend (YAML, as today) and an `agent.db` backend (rows): the Console's settings save
(`consolecmd/console_settings.go`, `auto_update_settings.go`), the model, route and MCP editors, WeChat login
(`internal/wechatlogin.Save`), `morph install` and `agentsettings`. A save changes only the rows it touches, in one
transaction. Validation before a save is unchanged; a route naming a profile that does not
exist is still rejected by the code, not by a foreign key, since a profile can come from the environment.

**Reading it from outside the backend.** The desktop shell reads `auto_update.enabled` and `auto_update.channel`
from the config file before the backend runs (`desktop/nsh/src/config.rs`). Without `--config`, it reads them from
the backend's settings API once the backend is up, logged in as the Console is (the session token the Console keeps
in the app's local store); with a Console password and no valid login yet, it waits for the user to log in and reads
them then. Until then it uses the defaults.

**Editing by hand.** `morph config get <path>` and `morph config set <path> <value>` change one setting;
`morph config export <file>` writes the whole config as YAML (in the order of `config.example.yaml`) and
`morph config import <file>` reads one back, replacing the config in one transaction. `morph config edit` is export,
`$EDITOR`, then import. Comments in an imported file are not kept (the `.imported` file keeps the original).

## Design: usage.db

```sql
CREATE TABLE llm_requests (
  id                          INTEGER PRIMARY KEY,
  ts                          INTEGER NOT NULL,   -- Unix milliseconds, UTC
  run_id                      TEXT NOT NULL DEFAULT '',
  origin_event_id             TEXT NOT NULL DEFAULT '',
  provider                    TEXT NOT NULL,
  api_base                    TEXT NOT NULL DEFAULT '',
  api_host                    TEXT NOT NULL,
  model                       TEXT NOT NULL,
  operation                   TEXT NOT NULL DEFAULT '',   -- chat, evaluate, image_generate, image_edit, transcribe
  scene                       TEXT NOT NULL DEFAULT '',
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  total_tokens                INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_details               TEXT NOT NULL DEFAULT '{}',  -- map[string]int64 as JSON
  cost_currency               TEXT NOT NULL DEFAULT '',
  cost_estimated              INTEGER NOT NULL DEFAULT 0 CHECK (cost_estimated IN (0, 1)),
  cost_source                 TEXT NOT NULL DEFAULT '',    -- 'provider': reported with the call; 'catalog': priced from the pricing catalog; '': none
  input_cost                  REAL NOT NULL DEFAULT 0,
  cached_input_cost           REAL NOT NULL DEFAULT 0,
  cache_creation_input_cost   REAL NOT NULL DEFAULT 0,
  output_cost                 REAL NOT NULL DEFAULT 0,
  total_cost                  REAL NOT NULL DEFAULT 0,
  duration_ms                 INTEGER NOT NULL DEFAULT 0,
  evaluation                  TEXT                         -- EvaluationRecord as JSON, for evaluate calls
);
CREATE INDEX llm_requests_by_ts ON llm_requests (ts);
CREATE INDEX llm_requests_by_model ON llm_requests (model, ts);
CREATE INDEX llm_requests_by_host ON llm_requests (api_host, model);
CREATE INDEX llm_requests_catalog_priced ON llm_requests (cost_source) WHERE cost_source = 'catalog';

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- pricing_digest, import marks
```

- **One row per successful call**, written by `UsageClient` where it appends a JSONL line today. Every client shares
  the database, and SQLite's lock replaces the missing lock between processes.
- **Pricing after the fact** stays: a chat call without a reported cost is priced from the catalog when it is
  recorded (`cost_source = 'catalog'`). When `meta.pricing_digest` differs from the running catalog at startup, the
  catalog-priced rows are priced again in batches, then the digest is saved. This replaces the projection's
  rebuild.
- **`GET /stats/llm/usage`** (overall, by model, by API host and model) is three `GROUP BY` queries; the
  projection file and its offsets go away.
- **`GET /stats/llm/daily?days=N&tz=`** stops rescanning JSONL: the server computes each local day's UTC start and
  end in the requested time zone (so DST and half-hour offsets stay right) and runs one query that joins those
  ranges to `llm_requests` on the `ts` index, grouped by day and model.
- **Retention:** a new setting, `stats.llm_usage.retention_days`, default 0 (keep everything, as today). When set, rows
  older than that are deleted daily.

`stats/topics_projection.json` (a cache of the journal's topic list) is a different thing and is out of scope.

## Backups

The Cloudflare deploy tars the live state folder every few minutes (`deploy/cloudflare/start.sh`, `backup_state`).
A live SQLite database and its WAL can be captured at different moments, and such a backup may not restore. This
already applies to `journal.db` and `memory.db`; it must be fixed before more state moves into SQLite.

- New command `morph state snapshot <dir>`: `VACUUM INTO` each database (`journal/journal.db`, `memory.db`,
  `agent.db`, `usage.db`) and copies the remaining state files, giving a consistent copy while the server runs.
- `start.sh` tars the snapshot instead of the live folder. `--skip usage` leaves `usage.db` out where its size
  matters.

## Import

Each store imports its files the first time its database opens, as a migration step (`sqlitedb.Migration.Apply`), in
one transaction:

| Files | Into | Then |
| --- | --- | --- |
| `config.yaml` at the default path (`~/.morph/config.yaml`), only when `--config` is not given | `settings`, `llm_profiles`, `llm_routes`, `llm_route_candidates`, `mcp_servers`, `console_endpoints`, `auth_profiles` | renamed `config.yaml.imported` |
| `persona/identity.yaml` | `identity` (unknown keys into `extra`) | renamed `*.imported` |
| `persona/soul.md` | `identity.soul`, without front matter; empty when the front matter says `status: draft` | renamed `*.imported` |
| `HEARTBEAT.md` | `heartbeat_workflows`, one per `## ` section after HTML comments are removed; text outside a section becomes a workflow titled "Checklist" | renamed `*.imported` |
| `contacts/ACTIVE.md`, `INACTIVE.md` (after `MoveContactProfiles`) | `contacts`, `contact_handles` | renamed `*.imported` |
| `contacts/bus_inbox.json`, `bus_outbox.json` | `contact_bus_inbox`, `contact_bus_outbox` | renamed `*.imported` |
| `cron.yaml` | `cron_tasks` | renamed `cron.yaml.imported` |
| `console/sessions.json` | `console_sessions` | renamed `*.imported` |
| `agentlink/peers.json` | `agentlink_peers`, `contacts.deactivated_by` | renamed `*.imported` |
| `topics/*/context*.json`, `topics/*/workspace.json` | §6 tables | folder renamed `topics.imported` |
| `stats/llm_usage/*.jsonl` | `llm_requests` | folder renamed `llm_usage.imported`; projection file deleted (derived) |

- A record that does not parse is skipped and listed in `meta` (`import_rejects:<store>`), as the journal does
  with `journal_import_rejects`; the rest still imports.
- An install with no files starts with empty tables. New installs no longer write the templates as files:
  `morph install` writes the identity, the chosen soul preset, the config and an empty TODO list into `agent.db`.
- The `.imported` files are removed by a later release, not by this one.

## Agent and Console access

What read or wrote the files directly, and what replaces it:

| Today | After |
| --- | --- |
| `system.md`: contacts are at `contacts/ACTIVE.md` / `INACTIVE.md` | a `contacts_list` tool (status, kind, channel filters) and the prompt line pointing to it |
| `HEARTBEAT.md` template comment: `read_file` the contacts file | the same, with `contacts_list` |
| `agent_send` shown only while `ACTIVE.md` has a `kind: agent` contact | the same check on `contacts` (`status = 'active' AND kind = 'agent'`) |
| `read_file` / `write_file` on persona files or `HEARTBEAT.md` (possible, not prompted) | not possible; the identity and soul are in the prompt already, the heartbeat workflows are the heartbeat task |
| Console `/persona/files/*` (whole `identity.yaml` / `soul.md`) | the identity's fields, soul included, edited through the persona API; the routes render and parse the old file shapes for one release |
| Console `/state/files/HEARTBEAT.md` | a heartbeat workflows editor (list, add, reorder, switch off, edit); the route renders and parses the checklist for one release |
| Console settings (read and save `config.yaml`) | same routes; saved through `configstore.Store` (§7) |
| Desktop shell reading `auto_update` from the config file | the backend's settings API, unless `--config` names a file (§7) |
| Editing `config.yaml` in an editor | `morph config edit` / `export` / `import` (§7) |
| Console `/contacts/files/*` (whole-file edit) | removed; the per-contact YAML editor (`/contacts/item`) stays, rendering and parsing one contact |
| Console `/todo/files/*` (raw `cron.yaml`) | same route, rendering the tasks as `cron.yaml` text and parsing it back on save |
| Editing `soul.md` in an editor or keeping it in git | `morph state export <dir>` writes `config.yaml`, `identity.yaml`, `soul.md`, `HEARTBEAT.md`, the contacts and the TODO list as the files they were; `morph state import <dir>` reads them back |

## Implementation plan

Each step ships on its own and leaves the others on files.

- **M0. Backups.** `morph state snapshot`, and `start.sh` using it.
- **M1. usage.db.** Store, writer in `UsageClient`, the two stats routes as queries, re-pricing on a digest change,
  retention setting, JSONL import.
- **M2. agent.db and the small state.** Open `agent.db`; Console sessions, Agent Link peers, topic state (§4 to §6).
- **M3. Persona and heartbeat.** `identity`, `heartbeat_workflows`, the persona API and the
  Console editors, install, prompt and heartbeat loading.
- **M4. TODO.** `cron_tasks`, the Console routes and the raw editor, `todo_update`, the scheduler lock rename,
  `last_run_*`.
- **M5. Contacts.** Tables, `FileStore` replaced by a SQLite store with the same methods, handle lookups instead of
  scans, `contacts_list`, prompt changes, bus inbox and outbox.
- **M6. Config.** The config tables, the bootstrap state folder (`--state-dir`), `configstore.Store` and its
  writers, loading from `agent.db` into viper, the `morph config` commands, the desktop shell's settings read, the
  import.
- **M7. Export and import commands**, docs (`docs/console.md`, `docs/tools.md`, `docs/prompt.md`,
  `assets/config/config.example.yaml`).

## Tests

- Each store: round trip of every field through its table, including empty and missing values; the import of a
  real-shaped file per store (the templates in `assets/config` and fixtures), rejects listed, the file renamed.
- Contacts: lookup by every handle field; a shared group chat ID finding several contacts; the active limit moving
  the oldest; Agent Link reactivating only what it deactivated.
- usage.db: the overall, by-model and by-host totals equal the projection's on the same JSONL; daily buckets across
  a DST change and in a +05:30 zone; re-pricing after a digest change; two processes writing at once.
- Cron: list order kept through `PUT /todo/tasks`; the `at`/`cron` check; the scheduler lock still exclusive.
- Snapshot: a snapshot taken during writes opens and passes `PRAGMA integrity_check`.
- Config: `config.example.yaml` and real configs imported and loaded back give viper the same values as the file
  (every key path, profiles, a route as a name and as candidates, servers, endpoints, auth profiles), with `${VAR}`
  expansion, flag overrides and environment variables in the same order; unknown keys round-trip; `--config` never
  touching `agent.db`; `export` then `import` changing nothing.
- Persona and heartbeat: identity with extra keys; an empty soul left out of the prompt, a draft soul imported as empty; the heartbeat task rendered
  from enabled workflows only, and none when all are off; the template's commented example imported as nothing.
- Console: the settings page, the persona, heartbeat and TODO editors and the contacts YAML editor work unchanged
  against the new stores.

## Implementation notes

Where the code differs from the text above, and why:

- **Imports are marked, not numbered.** The schema of every table is one list of migrations in
  `internal/agentdb` (one `user_version`). Each store's import is an importer its package registers;
  it runs in a `BEGIN IMMEDIATE` transaction that also writes `imported:<store>` in `meta`, so a
  process that does not link a store's package neither imports its files nor marks them imported.
  The files are renamed after the commit, and every open finishes renames a crash left undone.
- **Topic folders stay.** A topic folder also holds its context checkpoint and found tools, and
  `topics/layout.json` holds the topic list's layout; none of these is in §6. So the imported files
  are renamed in place (`context.json.imported`, ...) instead of renaming `topics/`. A
  `workspace.json` in a folder with nothing else naming its conversation key is imported the first
  time that key is asked for.
- **Legacy contact profile fields.** `memories.MoveContactProfiles` cannot run inside the contacts
  import (the memories package imports contacts). The import keeps `persona_brief` and
  `topic_preferences` in `meta` (`contacts_legacy_profiles`) in the same transaction, and
  `MoveContactProfiles`, which runs when a run attaches memories, turns them into memories and
  clears them. They never become contact columns.
- **Contacts keep only the Contact's fields.** Unknown keys in a contact's YAML (which the file kept)
  are not stored.
- **The config document.** `internal/configstore` renders the config tables as a YAML document in
  `config.example.yaml`'s order and saves a document by updating only the rows that differ, so the
  code that edits the config keeps editing a document. A column holds a value only when it has the
  column's type and is not its default; anything else about an item (an empty value written out, a
  value of another type, a key without a column) is a `settings` row at the item's path
  (`mcp.servers[<name>].<key>` for the named lists), so a saved document reads back the same,
  comments aside. A route written as `{profile: x}` reads back as `x`. The agent.db config is
  named `<state>/agent.db#config.yaml`, so paths relative to the config resolve in the state folder.
- **The state folder.** Besides `--state-dir` and `MISTER_MORPH_FILE_STATE_DIR`, `file_state_dir` in
  an older `~/.morph/config.yaml` (or its `.imported` copy) still settles the state folder, so an
  install that moved its state keeps finding it.
- **Times** in `agent.db` are RFC 3339 UTC to the second, so the text sorts as the times do; the bus
  outbox keeps nanoseconds in a fixed-width form.
- **The desktop shell** passes `--config` to the backend only when it was given one.
- `morph config where` prints which config is in use; `morph state export|import` writes and reads
  `config.yaml`, `persona/identity.yaml`, `persona/soul.md`, `HEARTBEAT.md`,
  `contacts/ACTIVE.md`, `contacts/INACTIVE.md` and `cron.yaml`.

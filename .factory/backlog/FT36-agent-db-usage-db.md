# Move the agent's state into SQLite: agent.db and usage.db

## factory · 2026-11-08 23:45
Registered at the owner's request: "please design the tables for agent.db first, write to docs/feat/ and submit
this task as backlog." The owner chose the files: `agent.db` and `usage.db` (new) beside `memory.db` and
`journal/journal.db`, and no others.

The design is `docs/feat/feat_20261108_agent_db.md` (tables, import, agent and Console access, implementation plan
M0 to M6). In short:

- `agent.db`: persona documents (identity.yaml, soul.md, HEARTBEAT.md, verbatim, with revisions), contacts with
  their channel handles and the bus inbox and outbox, TODO tasks (cron.yaml), Console sessions, Agent Link peers,
  and topic state (context.json, the context snapshot and request, workspace.json).
- `usage.db`: one row per LLM call, replacing `stats/llm_usage/*.jsonl` and its projection.
- Stays a file: config.yaml, logs, the guard audit log, persona and contact avatars.
- First, `morph state snapshot` so the Cloudflare deploy backs up the SQLite files consistently instead of tarring
  them live.

Acceptance criteria:
- Behaviour is unchanged for prompts, tools, channels and the Console, except where the design replaces direct file
  access (a `contacts_list` tool; the Console's whole-file editors).
- Each old file is imported once in a transaction and renamed `*.imported`; unparseable records are listed, not lost.
- The tests listed in the design pass, including totals equal to the old projection and daily buckets across DST.

Backlog: the design is for the owner to review first. Build it in the design's milestones, one item each, when it
moves to new/.

## factory · 2026-11-09 00:03
Scope added at the owner's request: "i'd like to migrate config.yaml to agent.db as well."

The design now covers it (§7 Config, milestone M6): the config is a verbatim YAML document in `agent.db` with
revisions, loaded in the same order as today (defaults, YAML, `${VAR}` expansion and flag overrides, environment).
`file_state_dir` becomes a bootstrap setting (`MISTER_MORPH_FILE_STATE_DIR` or a new `--state-dir`), since the
config cannot say where its own database is. `--config <path>` keeps using that file, so systemd, the Cloudflare
deploy and the desktop shell keep working; the default `~/.morph/config.yaml` is imported. Every config writer
goes through one `configstore.Store`; `morph config edit` / `show` / `export` / `import` replace editing the file.

## factory · 2026-11-09 00:10
Design changed at the owner's request: "you shouldn't simply use documents table for those thing."

The config, persona and heartbeat are no longer stored as verbatim text documents. The design now gives them
tables: `settings` (one row per config key path, typed by the Console's settings registry) plus `llm_profiles`,
`llm_routes` and `llm_route_candidates`, `mcp_servers`, `console_endpoints` and `auth_profiles`; `identity` with
a column per field; `soul` with status and preset columns and its Markdown body; `heartbeat_workflows`, one row per
checklist workflow with an on/off switch. One `change_log` records before and after for every change (secrets
logged without values). See §1 and §7 of the design.

## factory · 2026-11-09 00:14
Design changed at the owner's request: "soul could be similar a text field of identity. why we need a change_log?"
and, on removing the change log, "yes".

- The soul is a text column of `identity` (Markdown, no front matter); there is no `soul` table, status or preset.
  A draft `soul.md` is imported as empty, its original kept as `soul.md.imported`.
- There is no `change_log`: recovery is `morph state snapshot` and the export commands.

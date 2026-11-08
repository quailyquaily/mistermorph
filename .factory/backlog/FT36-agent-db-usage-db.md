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

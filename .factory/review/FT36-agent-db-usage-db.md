---
branch: factory/FT36-agent-db-usage-db
round: 3
---
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

## factory · 2026-11-09 00:15
Moved backlog → new at the owner's request: "update it to FT36's branch, and move it to new/".

The design is committed on the item's branch, `factory/FT36-agent-db-usage-db` (90cd3ed5,
`docs/feat/feat_20261108_agent_db.md`), and is not on master. Builds continue on that branch.

## lyric · 2026-11-09 00:17
Build the feature designed in `docs/feat/feat_20261108_agent_db.md` on this branch: move the agent's state into
`agent.db` and `usage.db` as the design describes, following its milestones (M0 to M7) and its tests.

## factory · plan · 2026-11-09 03:33
Behaviour: implement M0 safe snapshots first, then M1–M7: usage, small state, persona/heartbeat, TODO, contacts, config and export/import. Preserve runtime/prompt/channel semantics and config precedence; empty installations create empty schemas, legacy imports are transactional and repeat-safe with rejects recorded and originals retained. Explicit --config remains file-backed.

Scope: the complete design on the existing branch, as requested by the latest owner section. Logs, audit, avatars, accountdm peers and topic projections stay files. Existing memory and journal storage is unchanged. Never paths remain unchanged.

Decisions: use central agent.db migrations, structured tables and a soul column with no change log. Import marks commit with data; renames occur after commit and are retried. Implement milestones in topical commits rather than splitting this owner-approved item.

Checking: store field/import/reject/rename tests; usage parity, concurrency, repricing, DST/+05:30; config precedence and explicit-file behavior; contacts handles/limits; cron ordering/locks; persona and heartbeat; live snapshot integrity; full Go gate and Console check/tests. Manual UI checks remain separate.

## factory · 2026-11-09 03:33
Built M0–M7 with Claude Code; pushed head df7ff8c0. Round 1; new → review.

Implemented SQLite stores, transactional legacy imports, live snapshots and Cloudflare integration, config/state commands, contacts_list, structured persona/heartbeat APIs and Console editors, TODO last-run display and database-backed config source information. Database-backed /var/lib/morph_nest edits now fail clearly; whole-document import/install omit the bootstrap key as documented.

Manager independently reran the configured gofmt/vet/test gate successfully after the final fixes; forbidden paths unchanged. Coder reports 162 Go packages passing uncached, nsh check passing, 276 Console tests passing; desktop 47 passed/1 ignored and Cloudflare 24 passed before the final UI fixes. No deployment performed.

Install: unpinned user-level goimports @latest; local pkg-config shim for existing fontconfig libraries. No dependency manifest or lockfile changes. All scripted tests used throwaway HOME directories.

Review attention: topic legacy files rename individually because the folder holds out-of-scope state; legacy contact profiles are retained in meta then moved to memories later, and unknown contact YAML keys are no longer kept. Config preserves otherwise-unrepresentable values in settings, normalizes profile-only route objects, and permits legacy bootstrap state-folder resolution. Agent DB timestamps generally use second precision. Empty test-generated SQLite artifacts were accidentally included in an intermediate commit, then removed without rewriting history; coder inspected them and reported only schema/import markers, no user data or secrets. Empty-state-dir regression tests prevent recreation.

Not checked manually: browser, desktop and Android UI, especially persona/heartbeat editors and TODO last-run display. No live Cloudflare/R2 backup test; no nsh production build or pinned-toolchain rustfmt check. Review should verify these differences and migration safety before approving shipment.

## factory · review · 2026-11-09 03:49
head: df7ff8c070fd396a6d57fcdf6885a8d982327908
verdict: fix
fix:
- [P1] cmd/mistermorph/root.go:275: Contacts migration runs before config is loaded, ignoring custom contacts.dir_name. Example: contacts.dir_name=people with people/ACTIVE.md produces an empty contacts table on two successive starts while imported:contacts is already set. Resolve migration configuration before importing and marking completion.
- [P1] internal/statefiles/statefiles.go:241: Partial contacts import calls ReplaceAll and deletes the omitted status collection. Example: active tg:123 and inactive tg:456, importing only contacts/ACTIVE.md succeeds but deletes tg:456. Replace only supplied collections atomically; preserve omitted ones.
notes:
- [P2] internal/configstore/store.go:87: Multi-table config reads lack a consistent transaction snapshot. Alternating two coherent configurations produced an export with llm.model=B and review_marker=A, a combination never committed. Read all tables within one transaction.
- [P2] internal/configstore/store.go:515: Config import does not recover the post-commit/pre-rename interruption. Recreating that state leaves the legacy file unrenamed on restart; corrupting it then makes config where exit 1 despite valid database config. Persist pending rename state and retry without parsing an already imported source.
- [P2] internal/statefiles/statefiles.go:84: Exporting an empty soul leaves a stale soul.md. Export Old soul, clear the database soul, export to the same directory, then import: Old soul is restored. Export an explicit empty value.
- [P2] desktop/nsh/src/config.rs:82: Desktop auto-update settings request lacks authentication. With a Console password and auto-update enabled, the request returns 401 whereas an authenticated request returns enabled; after YAML migration the desktop falls back to disabled without retry. Use authenticated local access and retry after authentication is ready.
- [P2] cmd/mistermorph/consolecmd/setup_repair.go:148: Setup repair reads the database config identifier as a filesystem path. With valid database config, authenticated GET /console/api/setup/file?key=config returns 404. Use configstore.ReadFile.

Codex reviewed origin/master...HEAD against the design and item plan. No merge conflicts with origin/master. Configured gofmt/vet/test gate passed (162 Go packages); nsh check passed; nsh test --web-host tests/noHost.js passed (276 tests). Scripted tests used an isolated absolute temporary HOME. No installs; no tracked code changes or commits. Review-code skill was unavailable in the coder environment; review requirements were supplied in the task.

Not verified: desktop/Android GUI and live Cloudflare/R2 backup. Import recovery was tested by recreating interrupted state, not a real power loss. Reproduction artifacts retained locally. No linked GitHub issue or PR was present. Item stays in review/ for the owner to decide; add a note and move to new/ for fixes.

## factory · 2026-11-09 04:40
Moved review → new at the owner’s request: "Move FT36 back to new". Continue on the existing branch and address the review findings.

## factory · plan · 2026-11-09 05:01
Fix round 2 addition: address both P1 and all five P2 findings from the latest review. Resolve contacts migration configuration before imports, preserve omitted status collections atomically, read config in one transaction, recover pending legacy renames without reparsing, export empty soul explicitly, authenticate desktop settings and retry after login, and read database config in setup repair. Reuse existing stores/authentication; no new features or config keys. Add regression coverage for each finding, including repeated startup, partial-import directions, concurrent reads, interrupted import, soul roundtrip, setup repair and desktop auth readiness.

## factory · 2026-11-09 05:01
Claude Code fixed all seven findings in eight topical commits, df7ff8c0..44ea8790. Pushed 44ea8790; round 2; new → review. The worktree is clean and forbidden paths are unchanged. No base merge was needed.

Manager independently reran the configured gofmt/vet/test gate successfully. Coder reports 162 Go packages passing, repeated/race regression runs passing, and desktop cargo test --offline: 51 passed, 0 failed, 1 ignored. Console sources did not change, so nsh check/tests were not rerun. Scripted tests used absolute throwaway HOME directories.

No installs or manifest/lockfile changes. Desktop test build used temporary symlinks to existing system libraries and RUST_FONTCONFIG_DLOPEN; coder removed its temporary build output.

Not checked manually: desktop/browser/Android interfaces, especially password-protected desktop login and update checks. No live Cloudflare/R2 backup, real power-loss test, nsh production build or rustfmt check. Import interruption was simulated. Owner should inspect migration recovery, partial contacts import and desktop login/update behavior after the next review. No deployment or merge into master.

## factory · review · 2026-11-09 05:26
head: 44ea87904e06bc8ad021107ef9a9dc3911eecc77
verdict: pass
notes:
- [P2] contacts/db_store.go:43: Nested contacts.dir_name resolves the wrong database. With address/people, migration writes one contact into the state directory's agent.db while runtime opens address/agent.db and returns zero contacts. Pass the state database location explicitly rather than deriving it from the contacts directory's parent.
- [P2] internal/configstore/store.go:552: Config migration changes relative file targets when the default config directory differs from the state directory. A previously existing mixin.keystore_file=credentials/mixin.json resolves to a nonexistent state-directory path after migration, breaking sends. Preserve original relative-path targets during import.
- [P2] internal/cron/store.go:299: Semantic task deletion holds the agent.db write lock while waiting for the model. A concurrent context save waited about 9.7 seconds and failed with SQLITE_BUSY. Match outside the transaction and revalidate the target before committing.
- [P2] contacts/db_store.go:254: Contact and handle reads lack one transaction snapshot. Concurrent complete replacements returned nickname=V1001 with tg_private_chat_id=1002, a combination never committed. Read both within one transaction.
- [P2] internal/llmstats/usage_query.go:108: Usage summary queries lack one consistent snapshot. Concurrent appends produced total requests=1 but per-model requests summing to 3 in the same response. Share one read transaction across the aggregate queries.

Codex reviewed the full origin/master...HEAD range and fix-round changes df7ff8c0..HEAD. All seven previous findings' original trigger scenarios passed verification. No P0/P1 findings; review → ready under the factory threshold, with the five P2 defects above retained for owner consideration before shipping. No merge conflict with origin/master; no code changes or commits.

Validation: configured gofmt/vet/test gate passed (162 Go packages); nsh check passed; Console tests 276 passed; desktop cargo test --locked --offline 51 passed/1 ignored; Cloudflare startup script tests 10 passed; git diff --check passed. Reproduction assertions ran separately using overlays outside the worktree. Scripted tests used an absolute throwaway HOME. Desktop initial linking failed, then passed using existing shared libraries. No unpinned installs or manifest changes. Review-code skill was unavailable in the coder environment; review requirements were supplied in the task.

Not verified: manual browser/desktop/Android GUI, live Cloudflare/R2 restore and actual power-loss recovery (interruption was simulated). No linked GitHub issue or PR. No deployment or merge into master.

## factory · 2026-11-09 06:00
Moved ready → new for the owner-requested Claude Code verification and repair of the five remaining P2 findings. Continue on the existing branch; no release or merge into master is authorized by this fix run.

## factory · plan · 2026-11-09 06:56
Fix round 3: verify the five remaining P2 findings with pre-fix failing regressions, then fix explicit state-database selection for nested contacts folders, preserve config-relative file targets during legacy import, move semantic task matching outside write transactions with target revalidation, and use one read snapshot for contact/handle and usage aggregate responses. Retain the existing branch and feature scope; no release.

## factory · 2026-11-09 06:56
Claude Code verified and fixed all five reported trigger scenarios in six commits, 44ea8790..e6bd3620. Pushed e6bd3620; round 3; new → review. Runtime contacts callers now explicitly name the state directory; legacy public NewStore retains its parent-directory behavior. Config migration preserves relative llm.pricing_file and mixin.keystore_file targets. Semantic deletion matches without holding a transaction, then revalidates the task definition before deletion. Contact and usage reads use consistent transactions, including daily usage details.

Each defect has committed regression coverage; coder demonstrated failures against old code using external overlays. Manager independently passed the configured gofmt/vet/full Go test gate and git diff --check on final HEAD; worktree clean and protected paths unchanged. Coder reports 162 packages passing, relevant race checks passing, 20 repeated contacts/usage/cron runs and 10 root/configstore runs passing. Initial unbounded usage-test writer timed out under race; it was capped and reruns passed. No installs or dependency changes.

Limitations: environment-supplied relative paths still resolve from the new state directory; interpolation/secret-reference values are not rewritten during import. No Console/desktop source changes, so those suites were not rerun. No manual browser/desktop/Android, live Cloudflare/R2 or actual power-loss checks. No deployment, tag or merge into master. Await independent review before returning to ready.

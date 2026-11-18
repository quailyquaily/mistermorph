---
branch: factory/FT148-unified-job-ids-and-database-storage
round: 1
---
# Unified job IDs, job management, topic links and database storage

## factory · 2026-11-18 11:03
Owner requested that the agreed job changes from this conversation be added as one task to new/.

Requirements:
- Generate new job IDs as `job-<UUID v4>` in both the Console and tools. Identity must not encode the trigger type; future webhook- or mention-triggered jobs can use the same format. Do not implement those triggers in this task.
- Rename `todo_update` to `job_manage`, supporting add_once, add_recurring, get, update and delete, with get/update/delete targeting a stable job ID. Preserve compatibility for existing tool/config references and legacy IDs. Updates must not recreate jobs or change their IDs.
- Connect related topics to jobs with an explicit `job_id`, exposed to and used by the Topics page. Preserve topic IDs and execution history; derive job links for legacy cron topics. Keep job, topic and individual execution IDs distinct: repeated executions must retain separate run IDs.
- Replace cron.yaml as the authoritative job store with SQLite `jobs.db` under the configured state directory. Scheduler, Console and tools must share this database and observe changes safely, including across processes.
- Import existing cron.yaml once, transactionally and retryably on failure, preserving IDs, ordering, job fields and enabled/disabled state. Keep the original YAML untouched, do not reread it as authoritative after successful migration, and do not reimport deleted jobs. Explicitly report rejected duplicate/missing IDs; no silent data loss. Document that downgrades can see stale YAML.
- Update prompts, configuration examples and English documentation to match the renamed tool, IDs, storage and migration behavior.

Acceptance:
- Regression tests cover shared ID generation, legacy compatibility, management by ID, topic links and separate run identity, database CRUD/concurrency, first-run/empty storage, migration idempotence, rollback/retry, rejected records and preservation of existing data.
- Run required Go checks and the current Console's checks/tests. Verify the relevant Todo/Topics UI behavior and document any unverified browser behavior.

Context: Claude Code already produced an uncommitted prototype in the owner's working copy during this conversation. That prototype is not shipped or a factory branch; do not modify, reset or rely on the owner's working copy. Build against the current factory base and its current Console implementation, not obsolete Vue paths from the prototype. This task records the complete agreed scope, not a claim that the running instance has migrated.

## factory · plan · 2026-11-18 12:06

### Behaviour
Generate all new job IDs centrally as job-UUIDv4; retain legacy IDs. Expose job_manage add_once/add_recurring/get/update/delete, retaining legacy tool/config compatibility and stable IDs for updates. Scheduler, Console and tools share state-directory jobs.db and see committed cross-process changes. On first access import YAML atomically once, preserving IDs/order/fields/enabled state; failures roll back for retry, rejected records report explicit errors, original YAML stays untouched and deleted jobs never return. Inspect current master's existing database-backed storage and preserve already-migrated data, not only YAML. Explicit topic job_id with legacy _cron_ derivation preserves topic/history/run identities; Topics UI consumes this linkage and handles empty/missing jobs.

### Scope
Shared cron storage/IDs, scheduler/Console API, tools/config aliases, topic persistence/API and current nsh Console, prompts/examples/English docs and regression tests. No new triggers, owner prototype, deployment, UI redesign or forbidden paths.

### Decisions
Reuse existing SQLite driver/conventions. Preserve any preexisting database jobs and ordering before importing YAML; do not regress current master. Migration completion is transactional database metadata, not moving YAML. Reject invalid records explicitly without partial import. Explicit canonical job_manage config overrides legacy setting; otherwise honor legacy todo_update setting. Keep topic IDs unchanged and execution run IDs separate. Existing TODO UI naming may remain.

### Checking
Test UUIDv4 generation parity, legacy tool/config/ID support, get/update/delete and field preservation, CRUD/order/multi-store concurrency, empty/first launch, one-time migration/rollback/retry/rejections/untouched YAML/deleted-job non-resurrection/existing database preservation, explicit and legacy topic links and separate run identities. Run configured gofmt/vet/go tests, nsh check and current Console scripts/test.sh. Follow pinned version (AGENTS says nsh 0.5.1, do not downgrade). Test Todo/Topics behavior; report unverified interactive browser behavior explicitly.

## factory · 2026-11-18 12:06

Implemented in five commits, head `9f815854`: shared jobs.db storage and migration from existing database or YAML; canonical job_manage with legacy tool/config aliases; job-UUIDv4 generation; topic job_id links and distinct run identities; Console save revision protection; sensitive-file exclusions, snapshots, prompts, examples and English docs.

Decisions: preserve current master's already-imported database jobs before considering stale YAML; keep original YAML untouched and migration completion transactional. Invalid legacy records reject the import explicitly for retry. Canonical config overrides legacy config only when explicitly set. Console revision conflicts preserve pending edits rather than silently overwriting concurrent changes.

Installs: none.

Manager verification: gofmt check, go vet ./..., go test ./... all passed. nsh check passed. Required Console scripts/test.sh passed: 136 files, 0 failed; chat-attachments passed its isolated automatic retry after failure beside other tests. Coder's earlier suite had the same flaky test failing, then three isolated passes; manager's complete required runner is green. Added helper unit tests passed (7/7). Existing forbidden paths unchanged; worktree clean and diff whitespace check passed.

Regression coverage includes new/legacy IDs, tool/config aliases and stable updates, job CRUD/order/concurrent writers/cross-process visibility, empty state, migration once/rollback/retry/rejected records/original YAML/deletion non-resurrection/existing database preservation, explicit and legacy topic links, separate execution identities, and stale Console save rejection. Coder additionally checked real binaries against old-version state and fresh/rejected YAML migration.

Not checked: interactive browser, desktop and Android UI appearance; real platform crypto behavior; live Console against a running scheduler. Todo/Topics behavior has headless component coverage only. No deployment, no owner working-copy changes, no new trigger types.

Branch pushed. Moved new/ → review/ for independent review; not merged or shipped.


## factory · review · 2026-11-18 12:32
head: 9f815854c92ffbacebd0257ed758b994a865475c
verdict: pass
notes:
- [P2] internal/configdefaults/defaults.go:275 (also :299, :315): jobs.db is added only to default deny_paths. Existing installations explicitly configured with the old template's deny list do not inherit that default, exposing jobs.db and literal bash_env values to read_file, send-file and shell access. Verified scratch probe: read_file of jobs.db using the old explicit list returned 24,576 bytes containing the literal API_TOKEN value; the new default refused the same read. Preserve protection across upgrades by adding state databases to effective deny lists or migrating existing explicit lists; add an old-config regression test.

Independent Claude Code review covered origin/master...HEAD: five commits, 98 files. No P0/P1 findings. Per factory policy, P2 is nonblocking; moved review/ → ready/. Owner should inspect the upgraded-install deny-list exposure before shipping.

Validation: configured gofmt check, go vet ./... and go test ./... all passed with fresh Go cache; pinned nsh 0.5.1 check passed; required Console scripts/test.sh passed, 136 files and 0 failures. Reviewer verified the finding with a scratch-only probe. Manager confirmed unchanged review head, clean worktree and clean merge with current fetched master. No code changes or commits from review. Installs: none; pinned nsh fetched its routine TypeScript cache only.

Residual risks: no interactive browser, desktop or Android build/JVM tests; Todo/Topics UI only headless-tested. Cross-process sharing checked by unit tests, not two running binaries. Downgrade behavior documented but not exercised. Secret-bearing data paths not exhaustively verified; jobs.db-wal deny matching is not covered (agent.db-wal had a preexisting equivalent gap). No linked GitHub issues or PRs in this item. Not merged or shipped.

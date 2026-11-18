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

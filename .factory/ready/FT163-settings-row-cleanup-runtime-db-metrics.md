---
branch: factory/FT163-settings-row-cleanup-runtime-db-metrics
round: 1
---
# Clean up Settings rows and show database metrics in Runtime metrics

## factory · 2026-11-20 09:16
Owner clarifies that only the informational Config row should be removed, not the configuration editors. Also requests rounded corners for the Advanced settings row and database file size plus record counts in Runtime metrics.

### Requirements
- Remove the informational Config row under Settings → System (configuration storage location/export-import hint). Keep the actual configuration forms, persistence, and import/export functionality intact.
- Give the Advanced settings row rounded corners consistent with neighboring Settings rows/cards. Preserve its navigation, interaction, and accessibility behavior.
- Add database file size and record counts to Runtime metrics. Identify the relevant runtime database(s) and clearly label the database and counted records/tables; do not present an ambiguous total as a specific record type.
- Use human-readable size units and readable counts. Treat unavailable metrics distinctly from zero, and handle missing/inaccessible database files without breaking the metrics view.
- Obtain metrics through the appropriate backend boundary; do not expose sensitive database contents or add expensive full scans to frequent metrics refreshes.

### Acceptance and regression coverage
- Verify the Config row is absent, configuration editors still work, and the Advanced settings row has correct rounded corners on desktop, mobile web, and Android.
- Verify Runtime metrics displays accurate database size and record counts, including empty and unavailable states, without regressing existing metrics or refresh behavior.
- Add focused regression tests for the Settings changes and metrics retrieval/display.

## factory · plan · 2026-11-20 09:51
Behaviour: Remove only informational Config row, preserve editors/import/export, round Advanced disclosure. Show runtime database sizes and explicitly named table counts; distinguish unavailable from zero.

Scope: System section, shared disclosure styling, backend overview/storage aggregates, Runtime panel, translations and tests. No schema or configuration changes.

Decisions: Use existing state paths; aggregates only, no paths or contents. Include WAL size, cache bounded read-only counts, show unavailable on older agents.

Checking: Real temporary storage fixtures and overview tests; Settings/Runtime regressions and layout tests. Go formatting/vet/tests, nsh check, parallel Console suite; record visual limits.

## factory · 2026-11-20 09:51
Built commits 0a399ac4 and 7377fb6d (head: 7377fb6d). Config information row removed, forms/persistence/import/export preserved, Logs first. Advanced disclosure corners rounded without interaction changes. Runtime metrics now show database sizes including WAL and named per-table row counts for agent, journal, memory and usage stores. Missing/unavailable values distinct from zero.

Decisions: Read-only COUNT(*) cached by file changes, at most once per 30 seconds with shared 1.5-second counting budget; incomplete counts retry. Missing files not created; opening closed WAL databases may leave empty sidecars. No contents/absolute paths exposed. Existing configPath store field retained.

Installs: none; no manifest/schema/config-key changes.

Tests: manager independently passed Go formatting check, go vet ./..., go test ./.... Coder passed nsh check and Console scripts/test.sh: 145 files, zero failures. New storage/overview coverage includes populated/empty/missing/inaccessible/malformed/missing-table/cache/timeout states. UI tests cover removed row, retained forms, disclosure interactions, metrics states and layouts at 1100/390/320 widths.

Visual checks: headless Chrome real components with stub data at 1280/390 touch widths, using available 0.5.1 web runtime rather than repository 0.6.0. Full running Settings page, desktop GPUI and Android NOT visually checked; owner should inspect those platforms and metric labels.

Push: initial credential helper lacked repository-path context; retried successfully with command-local GH_REPO and credential.useHttpPath=true. Branch pushed; new/ → review/, round 1. No deployment.

## factory · review · 2026-11-20 10:07
head: 7377fb6d7593b2e83146f6e687bd90cf3fcbaf3a
verdict: pass
notes:
- [P3] internal/dbmetrics/dbmetrics.go:187: A request cancelled during count caches unavailable/unknown rows for healthy databases for up to 30 seconds. Avoid caching cancellation/timeouts, or detach counts from request cancellation while retaining their budget. Verified probe: memory.db with 2 rows, cancellation as counting starts -> unavailable and nil rows; a fresh request 10 seconds later still unavailable; at 35 seconds status=ok and rows=2.

Review: Claude Code inspected all 12 changed files on origin/master...HEAD. No P0/P1 findings. Manager checked clean worktree, item-only commits, no never-path changes and clean merge with base. No branch changes or installs.

Validation (coder): formatting, go vet ./... and go test ./... passed (166 packages); nsh check passed; required parallel Console scripts/test.sh passed, 145 files, 0 failures (303 seconds). No sequential duplicate suite. Scratch probes checked cancellation caching, count interruption and aggregate counting cost.

Residual risks: a very large/slow journal can exhaust the shared budget ahead of memory/usage counts; reproduced only with budget reduced to 20ms, not at production 1.5s. Cold-disk timings unmeasured. No pixel check on desktop web, mobile web, desktop GPUI or Android; nsh 0.6.0 web runtime/JDK unavailable. Owner should inspect rounded Advanced row and database metric labels on those platforms. Layout/state/interaction regression tests passed.

Move: review/ → ready/. No linked issue or PR found in source/header or owner sections; no GitHub comments required.

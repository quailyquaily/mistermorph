---
branch: factory/FT42-scientist-worker-names
round: 1
---
# Use famous scientist names for subagent and coder workers

## factory · 2026-11-09 07:06
The owner explicitly requested this feature and placement in new via Console:
> new feature request: use the famous scientist names to build the subagent / coder name list. Put it to new.

### Requirements
- Replace the current ordinary-person name pools with curated names of famous scientists for both subagents and coder workers, including nested workers.
- Use recognizable names, for example Einstein, Curie, Newton, Darwin, and Noether. These are examples, not an exhaustive or mandatory list.
- Preserve supported Console languages, using conventional localized scientist names where available and a consistent fallback otherwise. This supersedes FT21's ordinary native-person name requirement, not its identity or allocation guarantees.
- Keep existing random allocation, task-wide duplicate avoidance, exhaustion suffixes, and stable assignments across refresh, reconnect, replay and approval resume. Locale changes must not alter worker identity; switching back restores the name.
- Apply the same naming consistently to every worker-name surface. Keep execution identifiers, event associations, avatars and main-agent identity unchanged.
- Preserve readability of existing histories and handle existing persisted name indices safely when changing the pools.

### Acceptance checks
- Tests cover scientist pools and localized names, both worker types and nested workers, consistent display across surfaces, pool exhaustion, locale round trips, persisted assignments and legacy histories.
- Run repository-required checks and the Console checks if affected.

Queued in new at the owner's request. This intake does not implement or release the feature.

## factory · plan · 2026-11-09 09:45
Behaviour: New subagent and coder workers, including nested workers, draw famous scientist names. English runtime and Console positions agree; Chinese and Japanese name the same scientist, with English fallback. Preserve allocation, duplicate avoidance, suffixes, ids, avatars, replay and approval resume. Old histories remain readable.

Scope: Runtime name pool, Console naming helper, necessary tests and identity documentation; no layout, avatar or main-agent changes.

Decisions: Keep 32 entries and the allocation algorithm unchanged. Recognize legacy recorded ordinary names and keep frozen localized legacy pools. Index-only records use the scientist pool; unknown or inconsistent recorded names stay verbatim.

Checking: Pool parity and localized uniqueness, nested/shared allocation, exhaustion, locale round trips, persisted indices/seeds, legacy histories and all worker display surfaces. Run formatting, Go vet/tests, nsh check and Console tests with throwaway HOME. Report missing visual inspection.

## factory · 2026-11-09 09:45
Built and pushed commit 56115e18f51afc973f456d4624822e6e8c960708 on factory/FT42-scientist-worker-names; moved new/ → review/.

Implemented 32 scientist names with en/zh/ja pools; preserved random allocation, stable identifiers and avatars. Legacy records retain their ordinary names and localized forms; unsupported languages fall back to English. A pre-change task resumed after upgrading may contain old names for earlier workers and scientist names for later workers; the two pools are disjoint.

Installs: none. No manifest or config changes.

Checks: Manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`, `nsh check`, and `nsh test --web-host tests/noHost.js` (287 passed). Coder additionally reports `node --test lib/` (247 passed). All changes are within scope; no forbidden paths changed.

Not checked: UI was not visually inspected; rendered component tests cover names but not appearance. Chinese/Japanese conventional spellings have not had native-speaker review. Owner should inspect localized names and legacy-history display before shipping.

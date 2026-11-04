---
branch: factory/FT5-console-subagent-pid-and-names
round: 1
---
# Console: show subagent and coder names and process IDs in progress

## lyric · 2026-11-03 22:27

In the chat progress panel, subagent entries (`spawn`) and coder entries should say which worker they are and which process they run.

- Give each subagent and each coder a made-up name, for example a short friendly name, and show it on its progress entries. A name stays the same for that worker for the whole task, and different workers in one task get different names.
- When a subagent or coder runs a process (the Codex or Claude Code CLI, a terminal session, or a command), show its PID.

### Acceptance criteria
- Every subagent and coder entry in progress shows its name; the same worker keeps its name across updates and after the page reloads.
- Entries that started a process show its PID; entries without a process show none.
- Names and PIDs are kept in the task result, so finished tasks show them too.
- Regression tests cover name assignment (stable, distinct within a task) and PID reporting.

## factory · plan · 2026-11-04 11:14

**Behaviour:** Assign each spawn/coder worker a stable, task-local friendly name before progress begins; share identity across updates and results. Capture real PIDs after successful CLI, shell or terminal start; no PID for in-process workers or failed starts. Preserve metadata across completion and page reload; old records remain readable.

**Scope:** Worker context, structured events/results, process-start hooks, Console progress persistence and rendering, regression tests. No roster, unrelated output redesign or settings changes.

**Decisions:** Add optional structured worker metadata; independent worker IDs and a name pool with numeric suffixes guarantee task-local uniqueness. Retain multiple program-labelled historical PIDs, not liveness claims. Capture directly managed processes, not arbitrary CLI descendants.

**Checking:** Test stable/distinct/nested names and pool exhaustion, actual PID reporting and absent PIDs, serialization and persisted progress; run repository formatting, vet and tests plus Console tests/build. Visually inspect names/PIDs and finished-task reload when a browser is available.

## factory · 2026-11-04 11:14

Built and pushed commit `92762c7531b595d239c3b24f1fca57ba0c9f1967` on `factory/FT5-console-subagent-pid-and-names`; moved from `new/` to `review/`.

Implemented stable task-local worker identities and friendly names, structured real-process PID reporting, nested progress merging, completed-result persistence, and Console rendering. Multiple processes remain separate historical records. Existing history limits remain unchanged; older tasks remain compatible.

Installs: none reportable; no dependency or configuration changes.

Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with a throwaway absolute HOME. Codex also reports worker race tests, all 353 Console tests, and `pnpm build` passing.

Not checked: browser visual inspection or real Codex/Claude CLI integration; process regression tests use local substitute programs. Owner should inspect worker names, program/PID display, and persistence after reload on finished tasks.

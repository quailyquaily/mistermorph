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

## factory · review · 2026-11-04 11:24
head: 92762c7531b595d239c3b24f1fca57ba0c9f1967
verdict: fix
fix:
- [P1] Required Go test command failed with inherited environment: `TestHandleAgentSettingsPut` returned 409, expected 200. Codex reproduced the configuration-related failures on origin/master; this is a baseline/environment test gate, not a defect introduced by FT5 and has no changed-code location. Explicitly isolate the test environment before rerunning the gate. Fully isolated rerun passed; retained as a failing-test finding under the factory review rule.
notes:
- [P2] agent/engine_loop.go:1064-1066: Approval Resume does not establish a shared worker scope, so separate coder calls allocate the same worker ID/name and completion events lack worker metadata. Verified example: resumed calls coder-a and coder-b launched separate substitute CLIs but both used worker-1 / Milo, causing Console to combine their process records. Establish shared scope at Resume and preserve pre-approval allocation state.
- [P2] web/console/src/core/chat-task-history.js:314: Worker normalization reads only activity_id although its output uses activityId. Verified example: re-normalizing a bash entry through the polling path changes its label from Milo / bash PID 12345 to Milo. Accept both field spellings to preserve process-to-activity association.

Scope: Codex reviewed all 25 changed files in origin/master...HEAD. No tracked files changed, no commits made on the code branch, and no reportable installs. Branch merges cleanly with current origin/master.

Validation: formatting, go vet and go test passed on the fully isolated rerun (155 packages); worker/coder race checks passed; Console tests passed 353/353; pnpm build passed with bundle-size warnings. Initial inherited-environment configuration failures and a temporary-path normalization failure also reproduced on base. Browser component fixtures verified ordinary/nested names, PIDs and completed-record reload.

Not checked: real Codex/Claude CLI integration and full Console-service end-to-end reload. Owner should inspect the two P2 acceptance defects and decide whether to return this item to new/; it remains in review/ because of the recorded test gate.

## lyric · 2026-11-04 11:35
Fixed the review's P1 and both P2s on the branch; head is now 687edbb6. Please review again.

- [P1] The failing test came from the review's environment, not from FT5. Run inside mistermorph, the tests inherit its MISTER_MORPH_LLM_* variables, which mark LLM settings as managed by the environment: TestHandleAgentSettingsPut got 409 "llm.provider is managed by environment", and about 40 tests in six packages fail the same way on master. 59af02bf adds internal/testenv.ClearAppEnv and a TestMain in each of those packages that clears MISTER_MORPH_* first.
- [P2] engine_loop.go: 37f4ddb4 gives Resume the same shared worker scope as Run, and the resume state carries how many workers were named before the pause. TestWorkerNamesContinueAfterApprovalResume fails on 92762c75 with three coders all worker-1/Milo.
- [P2] chat-task-history.js: 687edbb6 accepts activityId as well as activity_id. A new test normalizes an entry twice and keeps "Milo · bash PID 12345"; it fails without the fix.

The full gate passes twice: in a clean environment, and with MISTER_MORPH_LLM_* and other MISTER_MORPH_* variables set (156 packages each). pnpm test: 354 passed, 0 failed; pnpm build passed.

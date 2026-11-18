---
branch: factory/FT149-todo-job-glass-toolbar
round: 1
---
# TODO job controls in a centered glass toolbar

## factory · 2026-11-18 14:30
Owner request:
> replace the block of text "The runs of the TODO item ..." to a toolbar,same style of  bottom nav, blurred glass and pill shape, center aligned, with 2 buttons: "Start" ( when the job is running, label it "Stop"), and "View Job".

Acceptance criteria:
- Replace the informational block beginning "The runs of the TODO item ..." with a horizontally centered toolbar in the same location.
- Match the existing bottom navigation's blurred-glass appearance, pill shape, spacing, and theme treatment; reuse shared styling where practical.
- Show exactly two buttons: "Start" and "View Job". While the associated job is running, the first button reads "Stop" instead.
- Start triggers the associated job immediately; Stop cancels its active execution, not its recurring schedule. Reflect actual running state, including runs started elsewhere, and prevent duplicate actions while a request is pending.
- "View Job" navigates to the associated job's detail view using its stable job ID, not a run ID.
- Handle missing/deleted jobs and request failures without presenting a false running state; keep controls keyboard accessible and usable on narrow screens.
- Add regression coverage for idle/running labels, start/stop behavior, pending/error states, and View Job navigation. Check visual consistency with bottom navigation on desktop and mobile.

Scope: this request concerns the run-information block, not the separate TODO detail text-editing toolbar in FT147. Use the current Console implementation and existing job APIs.

## factory · plan · 2026-11-18 15:03
Behaviour: Replace the TODO topic read-only information with a centered two-button toolbar. Resolve the associated job by stable topic/job ID and agent endpoint. Load authoritative state on first mount; refresh for activity and external runs. Start requests immediate execution; Stop cancels the active execution only, never its recurring schedule. Guard pending actions, ignore stale responses, and handle missing/deleted jobs and errors without claiming a run. View Job selects the stable job ID on the TODO page. Agent-topic notices stay unchanged.

Scope: Focused Console toolbar/controller, existing API reuse, shared bottom-navigation glass capsule, localization and regression tests. No schedule redesign, unrelated TODO editing toolbar changes, backend changes or config changes.

Decisions: Reuse the bottom navigation glass policy, tint, pill shape and opaque fallback. Keep exactly two buttons with appropriate disabled/pending states. Use runtime-confirmed running state, not optimistic labels. Use the existing activity refresh plus scoped polling with cleanup. Use stable-ID deep linking for View Job.

Checking: Cover topic/job mapping, idle/running/queued state, external starts, start/stop endpoints, duplicate guards, errors, missing jobs, stale responses and stable-ID navigation. Run repository Go checks, nsh check and the required parallel Console test wrapper; inspect desktop and mobile layout where possible.

## factory · 2026-11-18 15:03
Built in commits 1ecacb57 and d2a08bf1 on factory/FT149-todo-job-glass-toolbar; pushed head d2a08bf1.

- Shared GlassCapsule with the bottom navigation; centered two-button Start/Stop and View Job toolbar replaces the informational block.
- Uses stable topic/job IDs and the topic agent endpoint. Start invokes the existing immediate-run API; Stop targets the active run ID without changing the schedule. Pending guards, runtime reconciliation, activity refresh, polling cleanup, missing/deleted job handling and stale-response protection added.
- View Job opens the TODO page with stable-ID selection. Added keyboard focus styling and English/Chinese/Japanese strings, documentation and component-gallery coverage.
- Tests: manager reran configured gofmt/vet/go test command and nsh check on final commits: pass. Coder ran required Console scripts/test.sh on final code: 137 files, 0 failed. Added 17 toolbar regression tests.
- Visual checks: coder inspected headless Chrome with stubbed API on desktop, phone and 320pt narrow screen, including matching glass styles and opaque fallback. Native desktop and Android devices were not visually checked; live-server integration was not checked.
- Installs: no unpinned installs or manifest/lockfile changes.
- Push initially required repository-path credentials; command-local credential.useHttpPath=true resolved it. No persistent git settings changed.

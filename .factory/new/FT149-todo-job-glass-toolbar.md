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

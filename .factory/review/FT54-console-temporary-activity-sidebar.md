---
branch: factory/FT54-console-temporary-activity-sidebar
round: 1
---
# Temporary right sidebar for progress, plans, and agent output

## factory · 2026-11-10 00:50
Requested by the owner:
> New UI feature: design new temporary right sidebar for progress, plan, etc and subagent/ coder output. When clicking them, do not expand in the chat view anymore, instead, open the temporary sidebar. The sidebar and the original right  sidebar, they are mutually exclusive, so only one right sidebar will be shown, another will be close. And of course, use a good transition that fit our design.

Requirements and acceptance criteria:
- Clicking chat entries for progress, plans, and subagent/coder output opens their details in a temporary right sidebar rather than expanding details inline in the chat. Keep compact, identifiable entry points in the conversation.
- Show the selected entry's title/context and full available detail; preserve live updates, formatting, scrolling, and relevant existing actions. Switching entries updates the temporary sidebar without creating extra panels.
- The temporary detail sidebar and the existing right sidebar are mutually exclusive in both directions: opening either closes the other. Maintain a single active right-panel state, including during transitions.
- Provide an obvious close control and keyboard dismissal; return focus appropriately. Closing details must not alter task execution, chat draft, or conversation scroll position. Clear stale detail selection when changing conversation.
- Use restrained transitions consistent with existing Console styling, timing, and easing. Avoid panel overlap, layout flashes, and unnecessary chat scroll jumps; respect reduced-motion preferences.
- On narrow/mobile screens, use the existing responsive panel conventions with safe areas and reachable controls; do not squeeze the chat into an unusable column or restore inline expansion as a fallback.
- Cover opening each supported detail type, switching selections, mutual exclusion in both directions, dismissal, conversation changes, and streaming updates with regression tests. Check desktop/mobile layouts and transitions visually; explicitly report anything not verified.

Queued only; implementation and review have not started.

## factory · plan · 2026-11-10 04:31
Behaviour: Compact plan/progress/reasoning/worker entry points open full live details in a temporary right panel instead of inline. Switching replaces selection; workspace and details are mutually exclusive. Support close, keyboard/Back dismissal, focus restoration and clearing on conversation changes without changing task or draft. Empty/missing selections show an empty state.

Scope: Console chat controller/page, status and worker renderers, responsive panel shell and regression tests. No backend redesign.

Decisions: Store stable reply/task/worker IDs and resolve live data rather than snapshots. Reuse existing workspace layout motion, responsive sheet and safe areas, with reduced-motion support. Closing details does not reopen workspace; selecting the same entry toggles closed.

Checking: Cover all detail types, switching, mutual exclusion, dismissal, conversation changes, streaming and retained actions. Run configured Go checks, nsh check/build/tests and core tests. Inspect desktop/mobile visuals where available and record gaps.

## factory · 2026-11-10 04:31
Built and pushed e8efa578. Moved new/ → review/ (round 1).

Implemented a single active right-panel state, reactive full-detail rendering for plans/progress/reasoning/subagent/coder output, compact conversation entry points, close/Escape/mobile Back handling, selection cleanup and responsive safe-area sheets. Added localized empty-state copy and 10 regression tests; updated existing inline-panel tests.

Decisions: Workspace preference persists only on explicit workspace toggles; closing details leaves no right panel. Existing panel motion is reused. Escape guard covers Chat-owned dialogs only; other global dialogs may compete for Escape and should be checked in review.

Installs: none; reused existing tools.

Tests: configured gofmt + go vet ./... + go test ./... passed, independently rerun by manager. Coder reports nsh check and nsh build clean; nsh tests 355 passed, 0 failed; core Node tests 247 passed. Commit scope checked against origin/master; no forbidden paths changed.

Not verified: full Chat page desktop/mobile appearance, actual transitions and reduced-motion appearance, real Android/desktop devices. Only standalone panel screenshots were inspected by coder. No regression asserting conversation scroll preservation or entry focus restoration; composer focus preservation is covered. Reasoning streaming has no dedicated test (plans, progress and workers do). Dialog Escape delivery itself is not verified by headless tests. Review should inspect these interaction and layout gaps.

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

## factory · review · 2026-11-10 04:49
head: e8efa578b395ee298f5886eedd336666954e4401
verdict: pass
notes:
- [P2] web/console-nsh/pages/chat/ActivityDetailPanel.tsx:70-71: The always-active Escape binding takes priority over global dialogs and previously opened input suggestions. Example: open Plan, open the Agent picker, press Escape; details close while the picker stays open. Typing `/` before opening Plan likewise leaves suggestions open. Give the topmost dialog/suggestions dismissal priority.
- [P2] web/console-nsh/pages/chat/chatController.ts:1570-1571: Focus restoration is cleared within the same batched event before consumers see it. Example: focus Plan and press Enter, then focus Close and press Enter; activeElement becomes BODY and Enter cannot reopen Plan. Retain the restoration request until consumed or restore focus after unmount.
- [P3] web/console-nsh/pages/chat/ChatPage.tsx:283-285: Mobile dismissal replaces details with Workspace during the roughly 200ms exit animation and changes width to 88%. Example: at 390x844, closing Plan flashes a 342px Topic/Workspace panel before it exits, even when Workspace was not open. Retain outgoing detail content and width until animation completes.

No P0/P1 findings; moved review/ → ready/ under the factory review threshold. The owner should inspect the three interaction defects before shipping.

Validation (Codex): configured gofmt check, go vet ./..., go test ./... passed; nsh check/build passed; nsh tests 355/355 and core Node tests 247/247 passed. Reviewed origin/master...HEAD (merge base b0b7cc57540122fce453c6bbd303fe3bf7176899). Chrome static-build checks reproduced all findings and checked desktop/mobile layout, reduced motion, long-chat scroll restoration and reasoning/worker streaming. Manager verified unchanged HEAD and clean worktree. Branch merges cleanly with origin/master.

Installs: no unpinned installs; nsh restored pinned TypeScript 7.0.2. Tests used an absolute throwaway HOME.

Residual risks: actual Android/desktop hosts, physical-device safe areas and software keyboard, real WebSocket streams, end-to-end artifact preview/download not verified. Browser checks used mocked APIs. The nsh web-target test entry did not run successfully; static build with Chrome was used instead. No linked GitHub issue or PR.

## factory · 2026-11-10 07:47
Held out of v0.3.91: owner authorized shipping items if there are no problems; the concrete unresolved findings in the latest review remain. Left in ready/ without merging. No fixes attempted during this ship run.

## claude-code · 2026-11-10 08:29
Owner-requested check and fix of the three open review notes (local only; not pushed, not merged; item left in ready/).
Confirmed at e8efa578:
- [P2] Escape priority: ActivityDetailPanel.tsx:71 binds Escape `always`; the newest keymap binding wins and takes the key from nsh's native dialogs and menus. Reproduced headless with the Agent picker dialog (>8 agents, outside pageDialogOpen) and with composer suggestions opened before the panel. The Agent menu case did not reproduce headless (the headless Menu takes Escape itself).
- [P2] Focus restoration: chatController.ts:1570-1571 sets and clears the key in one call, so the entries' focus effects never see it (verified: inside a batch an effect sees nothing).
- [P3] Mobile exit: ChatPage.tsx:280/283 switch the sheet's width and content to the workspace panel as soon as the details close. Confirmed from the code; headless does not draw the sheet's exit.
Fix: local commit 361286a9 on factory/FT54-console-temporary-activity-sidebar (not pushed).
- A shared popup registry, `trackPopup` / `popupOpen` in components/ui.tsx, covers DialogLayer (Modal, MessageDialog, confirm), DropdownMenu, SelectField, AgentSwitcher's Menu and the composer's model picker and suggestions. The panel's Escape binding is dropped while any of them is open.
- `createFocusReturn` (components/chat/activityDetail.ts) keeps the request until the change has settled, then clears it.
- The phone sheet keeps the outgoing details and width (`mobileSheetDetail`) until it opens again.
Tests added in chat-detail-panel.test.tsx: agent dialog Escape, suggestions Escape (both failed before), focus-return request (reactive test), phone exit guard.
Tests (throwaway absolute HOME): nsh check passed; nsh test --web-host tests/noHost.js 360/360; gofmt check, go vet ./... and go test ./... passed (162 packages ok).
Not checked: real keyboard focus (headless cannot query focus or press a focused button), the Agent menu in a real browser, the sheet's exit look on a device, desktop/Android hosts. Native popups that this registry does not cover (Popover, BottomSheet, raw Select/Sheet on other pages) still lose Escape to the panel if one is ever shown over it.

## factory · 2026-11-10 09:08
Owner authorized merging the locally fixed items and tagging/pushing. Merged into master by c89e4e14; release head c89e4e14, tag v0.3.92. Master, tag and the four fixed feature branches pushed.
Combined validation: gofmt/vet and Go tests passed (162 packages); nsh check passed; Console tests 403/403; web Console/backend build passed; Android Java tests 15/15 and manifest tests 3/3 passed. No new installs. FT54 merge resolved by Claude Code, retaining both keyboard and sidebar behavior.
Not verified: real devices, actual keyboard/microphone/permission/lifecycle behavior, visual focus and transitions; no APK built. Previously documented residual limitations remain, including unanswered voice-start waiting and popup registry coverage. No linked issues or PRs to close. Moved ready/ → done/.

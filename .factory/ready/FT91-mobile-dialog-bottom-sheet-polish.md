---
branch: factory/FT91-mobile-dialog-bottom-sheet-polish
round: 1
---
# Fix mobile bottom-sheet safe areas, action widths, and transitions

## factory · 2026-11-11 13:31
Recorded from the owner's UI fix request.

Request:
> All dialogs, if them popup as a bottom sheets on mobile view, the safearea should be filled with the background color. If there are only 2 action buttons on the bottom of the dialog, make them the same width. And because they act as bottom sheets, so the transition should go from bottom to slide in, and slide out to the bottom.

Acceptance criteria:
- Audit all dialogs rendered as bottom sheets at mobile widths; apply consistent behavior through shared components/styles where possible.
- Fill the bottom safe-area inset with the sheet background color, with no transparent or mismatched strip; keep actions clear of system navigation and avoid double insets.
- When the bottom action row contains exactly two buttons, give both equal width. Preserve other action counts and desktop dialog layouts.
- Sheets slide in from the bottom on opening and slide out toward the bottom on closing. Keep the sheet mounted until its exit animation finishes; respect reduced-motion preferences.
- Preserve scrolling, keyboard/safe-area layout, dismissal, focus handling, and touch interaction.
- Add regression coverage for safe-area background, two-action sizing, and enter/exit states. Verify mobile web and Android app, plus desktop non-regression; explicitly record any platform not actually checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 18:34
Behaviour: Mobile dialogs paint the bottom safe area as part of the sheet, reserving navigation or keyboard clearance once. Open upwards and close downwards while mounted; reduced motion is immediate. Exactly two footer actions share width. Empty dialogs remain dismissible and changing/error content retains scrolling.
Scope: Shared DialogLayer, Modal, MessageDialog and SettingDialog audit, inset helpers, action rows and regression tests; preserve desktop and other action counts. No unrelated styling or dependencies.
Decisions: Use the existing mobile breakpoint and motion primitives. Count rendered actions, not declared conditional slots. Preserve existing MessageDialog equal-width choices.
Checking: Insets, action counts, enter/exit/reopen and reduced motion regressions; full Go and nsh checks, mobile web and desktop browser inspection; explicitly record unavailable device checks.

## factory · 2026-11-11 18:34
Built with Claude Code; commits 72e65a3e, 2bbe685d, d2ad3e96 (head d2ad3e96cf3fdbad29bf3ddf19230e641c101e00).
Shared sheet panels own painted bottom clearance; keyboard height replaces rather than doubles navigation inset. SettingDialog extends its footer background. DialogActions equalizes exactly two rendered actions; web context resolution is handled explicitly. Sheets slide over 260ms, remain mounted through exit and reverse on reopen; desktop retains fade/scale. Added 12 regression tests and documented runtime caveats.
Tests: gofmt clean, go vet ./... and go test ./... pass, independently rerun by manager. Coder reports nsh check and 633/633 nsh tests passing, with three deliberate mutations caught by regressions. Chrome inspection at 390pt with emulated 34pt inset confirms painted inset and 174/174 action widths; 1280pt desktop widths unchanged; enter/exit screenshots inspected by coder.
Installs: none; no manifests or config keys changed.
Not checked: physical Android/emulator, real iOS, desktop native window, software keyboard and device touch/scroll/swipe. Headless platform tests and helper tests do not establish those visual/device behaviors.
Review attention: coder observed pre-existing Chrome footer disappearance on conditional action toggling (no current consumers), long labels clipped at equal half widths, and pre-existing small-dialog side gutters. Verify these limits and native safe-area ownership before shipping.
Branch push initially lacked credential repository path; command-local credential.useHttpPath=true succeeded on retry. Moved new/ → review/ for round 1.

## factory · review · 2026-11-11 19:00
head: d2ad3e96cf3fdbad29bf3ddf19230e641c101e00
verdict: pass
notes:
- [P2] web/console-nsh/components/ui.tsx:1439: closing is not reset after fully hiding, so a later reopen incorrectly resumes the old exit offset. Verified Android-host probe: grow sheet from 143pt to 527pt while closed, reopen => first frame y=143 exposes 384pt immediately; closing on desktop then reopening at mobile width gives y=0 with no slide. Reset closing after completed/immediate hide, or distinguish still-shown exits; add both reopen regressions.
- [P3] web/console-nsh/components/ui.tsx:1592: untracked memoization snapshots a Modal footer getter, dropping top-level conditional element changes. Verified swap from Only to Cancel/Save stays Only on this head, while master updates correctly. Evaluate the footer through a reactive function. No current caller changes top-level footer elements; existing button reactive props still work.
Validation: Claude Code reviewed origin/master...HEAD; no P0/P1. Required gofmt, go vet ./... and go test ./... passed (162 packages, GATE_EXIT=0). nsh check passed; nsh test --web-host tests/noHost.js passed 633/633, including 13 dialog-sheet tests. Targeted regression probes reproduced the above notes; these are additional review probes, not failures of the required suite. Tests used isolated HOME directories. Worktree unchanged. Merge-tree check against master succeeded.
Installs: no new unpinned tools or dependencies reported; existing Go cache and nsh 0.4.0 used, with routine nsh cache creation.
Not checked: physical Android/emulator, real iOS, native desktop, real software keyboard and device touch/scroll/swipe. Host probes do not establish device visual behavior.
Moved review/ → ready/ under the factory rule (no P0/P1); owner should inspect the P2 reopen-motion defect before shipping. No linked issue or PR.

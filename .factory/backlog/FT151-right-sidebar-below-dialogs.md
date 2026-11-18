---
branch: factory/FT151-right-sidebar-below-dialogs
round: 1
---
# Keep the right sidebar below all dialogs

## factory · 2026-11-18 23:47
Owner request from Console:

> The right sidebar's z-index must be lower than all dialogs. Currently the right sidebar covers dialogs. Example: open the chat view's right sidebar, then click Rename; the rename dialog appears underneath the sidebar.

Requirements:
- Reproduce by opening the chat view's right sidebar and triggering Rename.
- Fix the stacking order so every dialog and its modal backdrop render above the right sidebar, including its contents and overlay where applicable.
- Ensure the sidebar cannot visually cover dialogs or intercept interaction intended for the active dialog; preserve existing sidebar and dialog open/close behavior.
- Check shared stacking contexts and layer definitions rather than fixing only the rename dialog with an isolated z-index increase.
- Verify the rename dialog and other dialogs reachable with the sidebar open on desktop and mobile/Android layouts. Add regression coverage for the stacking order and dialog interaction.

## factory · plan · 2026-11-19 00:13
Behaviour: With either the desktop sidebar or mobile workspace sheet open, every dialog and its scrim must sit above it and receive interaction first. Closing the dialog preserves the sidebar state. Empty, first-run and error dialogs use the same shared layer.

Scope: Shared Console dialog/sheet layering and regression tests; no backend changes or unrelated UI redesign.

Decisions: Use a shared modal layer across platforms, not a Rename-only z-index increase. Keep sidebars mounted under dialogs. Use repository-pinned nsh 0.6.0 (AGENTS.md), rather than the older version mentioned in factory rules.

Checking: Reproduce Android stacking in headless tests; cover Rename, Delete, shared Modal/MessageDialog, mobile sheets and desktop columns; check scrim, press, Back and Escape behavior. Run nsh check, the parallel Console test script, and configured Go checks. Report visual/device verification limitations.

## factory · 2026-11-19 00:13
Built commit 1aae9017d08f6f62748c9e6a523bc37a7498b7c4 on factory/FT151-right-sidebar-below-dialogs.

Shared DialogLayer now uses nsh Dialog on every platform, including full-screen Android layering with preserved insets. Removed Overlay-only Android handling and obsolete sheet Back workarounds. Shared pane Escape binding defers to active dialogs/popups; closing a dialog preserves the underlying pane. Added dialog scrim test IDs, regression fixtures/tests and updated PORTING documentation.

Tests: nsh check passed. Console scripts/test.sh passed: 140 files, 0 failed (247 seconds), including UI inventory. go vet ./... and go test ./... passed, independently rerun by manager. Configured combined test remains failing at its formatting gate: `gofmt -l .: internal/proctrack/proctrack_test.go`. Manager verified the same extra blank line exists in base 8d217db4; this branch changes no Go files and deliberately does not fix the unrelated baseline defect.

Regression comparison: Android shared-sheet fixture stacking and desktop column Escape tests fail on baseline and pass with this change. Full Console Rename/Delete flows also covered, but those headless flows alone do not detect baseline stacking due to the harness hit-testing limitation; dedicated fixtures cover that defect.

Installs: none. No prohibited paths changed.

Not checked: visual rendering on a desktop browser/window or real Android device/emulator (none available). Android translucent status bar behavior matches nsh sheets but needs device confirmation. Pre-existing focused Rename input Escape behavior was left unchanged.

Next: review shared layering and verify Rename/Delete with the right sidebar open on desktop/mobile/Android; note the pre-existing Go formatting failure.

## factory · review · 2026-11-19 00:34
head: 1aae9017d08f6f62748c9e6a523bc37a7498b7c4
verdict: fix
fix:
- [P1] internal/proctrack/proctrack_test.go:210: The configured test command exits 1 at its formatting gate because of an extra blank line. Example: `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` stops before vet/tests. Factory policy treats a failing configured test as P1. This is a confirmed pre-existing baseline failure, not a defect introduced by FT151; restore the baseline gate through an authorized change, then incorporate the corrected base and rerun the required command. Do not broaden this UI branch to fix unrelated Go code.
notes:
- No introduced code defects found in the 11 changed Console files against base 8d217db44ca21aaf7a024254e2a2f081b69a345b. Clean merge verified; no code edits or commits made during review.
- Validation: separate go vet ./... and go test ./... passed (165 packages); nsh 0.6.0 check passed; required parallel Console test script passed 140 files, 0 failed in 248s on an isolated rerun. An initial concurrent run was killed before retries; its result was discarded. Manager independently confirmed gofmt still lists the unchanged baseline file.
- Current app dialogs are declared after their sheets and pass stacking checks. Probes show declaration order remains essential: a dialog declared before a sheet is covered even on this head. That hypothetical ordering is not present in the current app.
- Pane Escape priority changes after a popup in a synthetic inline-prompt fixture; the actual Settings Telegram secret prompt passes on both base and head, so this is an unconfirmed risk rather than a finding.
- Not visually checked in a desktop browser/window or on an Android device/emulator. Android navigation-bar inset handling, keyboard-first Back behavior and visual hit coordinates remain unconfirmed.
- Installs: none. No linked GitHub issues or PRs. Round 1 of 3: returned to new/ under the mandatory failing-test policy, solely for the baseline formatting blocker.

## factory · 2026-11-19 01:38
Fix-round build could not proceed: authorized baseline formatting correction is absent from origin/master (8d217db4). Claude Code independently checked twice; no legitimate in-scope commit is possible. The formatting correction exists on FT152 only; merging or cherry-picking unrelated feature work was deliberately not done. No new commits, installs, or source changes. Existing branch and round retained.

Configured command still exits 1 at `gofmt -l .: internal/proctrack/proctrack_test.go`; separate go vet ./... and go test ./... pass. Unchanged Console tests were not rerun; no desktop/Android visual checks. Moved new/ → backlog/ until the authorized baseline fix is merged into master; owner can then return this item to new/.

Build-start notification could not be delivered (Telegram request timeout).

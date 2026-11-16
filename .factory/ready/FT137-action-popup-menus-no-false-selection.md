---
branch: factory/FT137-action-popup-menus-no-false-selection
round: 1
---
# Action popup menus: remove false selected-item styling

## factory · 2026-11-16 18:20

Owner request:
> Most popup menus contain actions, not selections. For example, on mobile, Settings → Models → the top-right menu should not have a selected item.

Scope and acceptance:
- Reproduce the selected-item appearance in the mobile Settings → Models top-right popup menu and inspect its cause.
- Audit action-only popup menus for the same behavior; opening an action menu must not mark the first item or another action as a persistent selection.
- Distinguish action menus from genuine choice pickers. Preserve selected-state indicators where they represent a real current choice, such as the LLM-profile picker.
- Keep keyboard focus, hover, and pressed feedback accessible and visually distinct from persistent selection; do not remove keyboard navigation or focus visibility to hide the issue.
- Preserve action activation, dismissal, and popup positioning. Verify the reported mobile case and affected desktop menus.
- Add regression coverage for opening action menus without a selected item and retaining genuine picker selection.
- Related: FT136 covers the composer plus-menu selection and popup sizing; this request extends the action-versus-selection fix to other popup menus without duplicating its scroll-sizing work.

Requested status: new. Investigation and implementation are pending.

## factory · 2026-11-16 18:21

Owner clarification:
> Check all popups. If there are similar issues, fix them together in FT137.

- Inspect all popup menus and pickers across the UI, on mobile and desktop, not only Settings → Models or known action menus.
- Fix every instance of the same false-selection issue found during that inspection as part of this item. Classify each popup by whether it represents actions or a genuine selection; preserve valid selected-state indicators and accessible focus feedback.
- Record the inspected popup locations and findings, and add regression coverage for affected popup types. Coordinate overlapping composer fixes with FT136 rather than duplicating them.

## factory · plan · 2026-11-16 18:52

### Behaviour
Opening action-only popups on mobile or desktop must show no persistent selection or initial action highlight. Pointer hover/press and explicit keyboard navigation remain visible and functional; opening never activates an action. Real choice pickers retain current value/checkmarks, including profiles and agent/model/settings selections. Preserve activation, Escape/outside dismissal and placement, including empty/disabled rows and first opening.

### Scope
Audit all popup consumers and shared DropdownMenu, PopupList, PickerList, PopoverPicker, selects and custom picker dialogs. Record a location/type/findings inventory. Fix every occurrence of the same false-selection issue, add regressions for affected popup families and genuine selections. No unrelated scroll sizing changes or dependencies. Do not merge FT136's branch: its existing shared action fix can be minimally reused when necessary with explicit overlap noted, leaving its sizing changes to FT136.

### Decisions
Settings Models top-right is DropdownMenu: mobile adapts to PopupList/PickerList, whose active starts at the first row even without value. Desktop uses nsh Menu; inspect actual focus/check semantics before changing. Distinguish active keyboard navigation from persisted choice without hiding keyboard focus. FT136 already implements no-initial-highlight in shared PickerList and role correction in PopoverPicker at local origin/factory/FT136-composer-popup-scroll-and-action-state; inspect those changes to keep compatible, not duplicate its sizing work. Default no unpinned installs. Follow current AGENTS.md nsh 0.5.1 rather than stale config version wording.

### Checking
Reproduce Models menu and inspect all popup locations mobile/desktop; verify opening, keyboard arrows/Enter/Escape, disabled/empty entries, hover leaving, activation/dismissal, and valid selected checks. Cover shared and custom popup types in regression tests, report inspection inventory and visual/native gaps. Run nsh check and required scripts/test.sh (not sequential whole-suite tests), configured gofmt/vet/go-test command, and diff --check; all scripted tests use absolute throwaway HOME. Read AGENTS.md and PORTING.md. No forbidden paths.

## factory · 2026-11-16 18:52

Built commits 4886dcaa and 5742363e; head: 5742363e. Moved new/ → review/.

Root cause: shared PickerList defaulted to the first enabled row when no current value matched, making mobile action menus look selected. No matching choice now opens without highlight; explicit Up/Down starts at last/first enabled row, Enter without highlight does nothing. Pointer highlight clears on leaving action rows. Real values retain selected marks. PopoverPicker without a value uses menu/menuitem roles. SetupPickerDialog without a selected value no longer highlights its first row; typed filtering still selects a navigation target. Models and other shared action menu triggers gained regression hooks.

Popup inventory: docs/console/popup-rows.md classifies Models, Channels, Skills, Contacts and TODO actions; composer add; language; settings/select controls; setup API/model dialogs; profile/agent choice pickers; date/calendar/tag/More/attachment surfaces and composer typeaheads. Shared false-highlight cases fixed; actual choices retained. Typeahead initial match intentionally retained.

FT136 coordination: minimally reused its shared action-highlight and role changes; no sizing changes and no branch merge. PickerList overlap may conflict when both ship: keep FT137 unmatched-value behaviour and all-disabled Up handling, together with FT136 sizing changes. Expected review attention: mobile checked language rows still announce as plain menuitem, not checkbox menuitem.

Installs: none unpinned; no dependency/lockfile changes.

Checks: nsh check passed. Required parallel Console runner: 127 files, zero failed, 256s; chat-attachments passed its isolated retry. New action-popup tests: 12; real Models menu regression included. Configured gofmt/vet/go-test gate passed, independently rerun by manager. Initial coder Go attempt hit full /tmp tmpfs; rerun with scratch TMPDIR/GOTMPDIR passed. git diff --check passed; only item-related commits, no never paths changed. Scripted tests used absolute throwaway HOME.

Visual: headless Chrome real Console with stub API, before/after Models menu at 390×844 touch and 1280×800 desktop; checked initial appearance, arrows/Enter/Escape, tapping activation, hover leaving and unchanged popup placement. Other popup locations inspected in code/test coverage, not visually in Chrome. Not checked: native GPUI desktop, real Android/emulator or screen reader.


## factory · review · 2026-11-16 19:10
head: 5742363ecee4c1aa861ec12344a6bd075fc1d3f2
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (14 files) against the request, clarification and plan. No qualifying introduced findings. Action-only initial highlighting, keyboard traversal and disabled rows, pointer leave, actual selected-value preservation, setup filtering and popup inventory checked. Branch merges cleanly with current origin/master.
- Validation passed: configured gofmt/vet/go-test gate; nsh check (0.5.1); required parallel Console test runner, 127 files, 0 failed, 488s; git diff --check. mobile-popup and chat-voice had parallel-run failures, both passed the runner's isolated retry; not established as baseline flakes. Scripted tests used absolute throwaway HOME and scratch temporary directories. Worktree remains clean, reviewed remote head unchanged.
- Installs: none. No files changed or commits made by reviewer.
- Residual risks: no fresh browser/native desktop/Android/screen-reader session in this review; visual confidence relies on builder's Models-menu Chrome checks. Language menu checkbox semantics are pre-existing. FT136 overlaps PickerList and PopoverPicker: preserve FT137 unmatched-value/all-disabled navigation together with FT136 sizing when resolving any ship conflict; combination not tested here.
- Moved review/ → ready/.

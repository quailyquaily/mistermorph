---
branch: factory/FT136-composer-popup-scroll-and-action-state
round: 1
---
# Composer popups: remove excess scroll space and false action selection

## factory · 2026-11-16 17:53

Owner request:
> The composer's plus-button and LLM-profile popups have scrollable content much taller than their actual items, creating unnecessary scrollbars. The plus-button popup should not need scrolling; the LLM-profile popup should scroll only when there are many profiles. The plus-button popup should not preselect its first item because its items are actions, not selections.

Scope and acceptance:
- Inspect the composer plus-button action popup and LLM-profile picker for excess scroll height, blank space, sizing constraints, and overflow behavior; establish the cause rather than assuming it.
- Size both popups to their actual content when it fits the available viewport; remove artificial empty scroll space and unnecessary scrollbars.
- The plus-button popup's normal action list needs no scrolling. Keep every action reachable on unusually constrained viewports without introducing artificial overflow.
- The LLM-profile picker scrolls only when its real content exceeds the available height, such as with many profiles; verify short and long profile lists.
- Do not render the first plus-button action as selected when opening the popup. These are actions, not persistent choices; retain appropriate keyboard focus and hover indicators without presenting them as selected.
- Preserve the actual selected-profile indication in the LLM-profile picker, popup placement, dismissal, and action activation.
- Verify mobile and desktop, constrained viewport heights, and keyboard navigation; add regression coverage for content sizing, real overflow, and the absence of a default selected action.

Requested status: new. Implementation and root-cause investigation are pending.

## factory · plan · 2026-11-16 18:24

### Behaviour
On first opening the action popup fits its real action rows without artificial scrolling or an initial highlighted/selected action. Hover works; arrow keys establish keyboard highlight and Enter activates. Profiles preserve selected-profile indication, filtering and dismissal. Both surfaces fit actual content up to available viewport height; real overflow scrolls, including constrained screens. Empty results remain compact.

### Scope
Investigate and fix shared PickerList/PopoverPicker sizing and composer action semantics; add regression tests. Preserve placement, dismissal, activation and other shared consumers. No unrelated UI changes.

### Decisions
PickerList initializes active=0 and highlights the first enabled item on open without a value, visually resembling a selection. Distinguish action menus from persistent selection, preserving keyboard navigation. Scroll currently measures an inner View, subtracts approximate chrome, and has a default flex-1 wrapper: establish the actual nsh Scroll/layout cause rather than guessing. Prefer measured content geometry to fixed heights. No new dependencies by default.

### Checking
Cover short/long profiles, normal two-action menu, empty filtering, desktop/mobile, constrained heights, first-open sizing, absent initial action highlight, hover, arrows/Enter, selection and dismissal. Read AGENTS.md, PORTING.md and shared picker code. Run nsh check, required parallel scripts/test.sh and configured gofmt/vet/go-test command with absolute throwaway HOME. Report visual/manual gaps explicitly.

## factory · 2026-11-16 18:24

Built in commits 0410bc4f, 3045672c, 010c0256; head: 010c0256. Moved new/ → review/.

Root cause: nsh counts SVG Image intrinsic dimensions as layout overflow even when icons are styled smaller. The two-action menu had 74pt rows but 304pt scroll content. Clip the rows container to exclude image overflow; cap the whole picker and let only rows shrink rather than subtracting assumed chrome heights or setting measured scroll height.

Action lists without a value now start without a highlight. Down starts at the first enabled action, Up at the last, and Enter without a highlight does nothing. Hover highlights clear on pointer leave. Selected-profile indication remains. PopoverPicker action rows use menu/menuitem roles. Added probe-backed geometry, keyboard, hover and composer regression coverage; updated PORTING.md.

Decisions: content takes the full available cap; removed the 80pt scroll minimum. Existing bubble/paper floors remain. Shared action menus use the same no-initial-highlight behaviour. Unrelated image overflow in other scroll views was not changed.

Installs: none; no dependency or lockfile changes.

Checks: nsh check passed; required parallel Console test runner passed (127 files, 0 failed, 243s, inventory passed). Configured gofmt/vet/go-test passed, independently rerun by manager. git diff --check passed; only item-related commits, no forbidden paths changed. All scripted tests used absolute throwaway HOME.

Headless Chrome inspected on the real Console with stubbed API: desktop 1280×800 and 1280×420, touch 390×844 and 844×390, with 2/30 profiles and empty filtering; before/after screenshots inspected. Short lists do not scroll, long lists do. Hover and keyboard checks passed.

Not checked: native GPUI desktop, real Android device/emulator, screen reader, real touch scrolling, software keyboard over the phone sheet; agent switcher/gallery not visually inspected (existing suite only).

First code push failed because the credential helper lacked repository path; retry with per-command credential.useHttpPath=true succeeded. No user settings changed.

## factory · review · 2026-11-16 18:55
head: 010c0256497e45f40fdecb6278efcab0e37c7839
verdict: pass
notes:
- [P3] web/console-nsh/components/shared/PickerList.tsx:118: Up in an action menu whose rows are all disabled highlights the first disabled row. step() changes from=-1 to 0 and returns that changed fallback when no enabled row exists. Preserve the original fallback instead. Verified scratch probe: open with disabled actions a and b -> no highlight; Down -> no highlight; Up -> a highlighted. choose() still blocks activation, so impact is cosmetic.

Reviewed origin/master e94180a1ac7b887cd08fc4c90d6743969917e31a...HEAD with Claude Code. No P0/P1/P2 findings. Verified the SVG intrinsic-overflow cause by removing the clipping in a scratch copy: 9/13 geometry tests fail; the normal add menu regains artificial scroll content. Checked shared picker consumers, selection semantics, sizing caps, keyboard behavior and clipping boundaries.

Validation: configured gofmt/vet/go-test gate passed (163 packages, none failed); nsh 0.5.1 check passed; required parallel Console test runner passed (127 files, 0 failed, 257s; inventory passed). chat-attachments.test.tsx failed once under parallel load with `Retry upload is covered`, passed the runner retry and 5/5 isolated repeats; treated as a pre-existing parallel flake. All scripted tests used absolute throwaway HOME. Worktree clean and HEAD unchanged. No installs or manifest/lockfile changes.

Not checked: native GPUI desktop, real Android device, screen readers, real touch scrolling or phone software-keyboard interaction. Builder's headless-Chrome visual pass was not repeated. Extremely low picker caps may expose less than one row, still reachable by scrolling. Existing unrelated icon-overflow scroll views and simultaneous hover/keyboard tinting are outside this change.

Moved review/ → ready/; owner should inspect popup appearance on native/mobile and the non-blocking all-disabled Up-arrow highlight.

---
branch: factory/FT104-topic-rename-select-current-name
round: 1
---
# Select the current topic name when opening the rename dialog

## factory · 2026-11-13 08:24
Owner request: "When renaming topics, in the rename dialog, select the current name by default."

When the topic rename dialog opens, focus the name input and select the entire current name by default, so typing immediately replaces it. Apply this on every opening, including reopening the dialog or renaming a different topic. Preserve existing save and cancel behavior, and do not reselect text while the user is editing.

Acceptance checks:
- Opening the rename dialog prefills the current topic name, focuses the input, and selects all of its text.
- Typing replaces the selected name without requiring a manual select-all.
- Reopening the dialog selects the current name again.
- Save and cancel continue to work on desktop and mobile.

## factory · plan · 2026-11-13 09:11
Behaviour: On every rename opening, prefill the current title, focus the mounted input and select its entire text once. Handle empty names, already-open initial mounting, retained/remounted fields, reopening and different topics. Ignore callbacks from closed/replaced sessions. Editing, regeneration and validation/save failures must not reselect text; save/cancel and keyboard dismissal remain unchanged.

Scope: Opt-in selection in the existing dialog focus helper, rename-dialog wiring, focused regression tests and platform testing notes. No dependencies or unrelated UI changes.

Decisions: Select once per session after focus and field readiness, using InputRef.setSelection and UTF-16 text length. Keep existing dialogs opt-in; do not track draft changes reactively.

Checking: Test opening, reopen/remount, topic changes, empty/emoji titles, late refs, stale callbacks, editing/regeneration/failure without reselection, save/cancel and non-opting dialogs. Run required Go checks, nsh check and full nsh test suite; check real browser selection separately where possible.

## factory · 2026-11-13 09:11
Built and pushed a22c9bf4 on factory/FT104-topic-rename-select-current-name. Added opt-in selectOnOpen to the focus helper, wired the rename dialog, added eight regression tests and documented headless selection limitations.

Tests: required gofmt/vet/go-test command passed (also rerun independently by manager); nsh check passed (also manager verified); full nsh suite passed, 859 tests, 0 failures. Coder's temporary real-browser fixture verified replacement typing, initially open mounting, reopening, topic changes, editing without reselection, Cancel, Enter and Save; fixture removed after check.

Installs: none; no dependency manifest or lockfile changes.

Not checked: native desktop UI and real Android device/emulator selection/keyboard behavior. Browser reopen during outgoing animation covered by helper tests only, not manual UI verification.

Initial branch push failed because git credential requests omitted repository paths; retry with per-command credential.useHttpPath=true succeeded. No user git settings changed.

## factory · review · 2026-11-13 09:45
head: a22c9bf4f207bfe280d6a50eb06d5f428556a57a
verdict: pass

Reviewed origin/master...HEAD (base 588ad961), all four changed files. No qualifying findings. Branch merges cleanly with base; review changed no code.

Validation: required gofmt/vet/go-test command passed; nsh check passed using existing nsh 0.5.0; full nsh test --web-host tests/noHost.js passed, 859 tests, 0 failures, including all 15 dialog-field-focus tests. Scripted checks used absolute throwaway HOME directories. Installs: none.

Not checked: real-browser selection during this review, Android/device and native desktop behavior. Headless tests verify selection calls, not visible selection. Owner should verify native selection for emoji-heavy titles (UTF-16 length versus maxLength), reopening during dialog animations, and replacement typing. These remain unverified platform risks, not confirmed defects.

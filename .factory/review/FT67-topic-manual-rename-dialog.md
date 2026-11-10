---
branch: factory/FT67-topic-manual-rename-dialog
round: 1
---
# Rename topics manually through a dialog with regeneration support

## factory · 2026-11-10 11:38
Owner request:
> new feature request:
> topic item can be rename mannually. you can replace the auto-regenerate button with a rename button, click to popup a rename dialog. on the dialog, there is a regenerate button, a input to rename mannualy, and a save button.

Replace the topic item's current auto-regenerate action with a Rename action that opens a dialog. Keep title regeneration available inside that dialog alongside manual editing.

Acceptance criteria:
- The topic item's Rename action opens a dialog with the current title in an editable input, a Regenerate button, and a Save button.
- Users can edit the title manually and save it; the persisted title appears in the topic list and other existing title displays and survives reopening/reloading.
- Regenerate uses the existing title-generation mechanism and puts the generated title into the editable input. Save commits the chosen title; closing/canceling without saving leaves the stored title unchanged.
- Handle empty/whitespace-only titles, regeneration/loading failures, and save failures clearly; retain user input on failure and prevent duplicate submissions.
- A late regeneration result must not overwrite newer manual edits or update another topic's dialog. Saved manual titles must not be immediately overwritten by routine automatic updates.
- Preserve desktop/mobile usability, keyboard access, dialog focus handling, and existing topic actions unrelated to renaming.
- Add regression coverage for manual rename persistence, regeneration followed by editing and saving, dismissal without saving, and failure/stale-response cases. Document UI/platform behavior not verified locally.

Registered only; implementation and verification have not started.

## factory · plan · 2026-11-10 16:46
Behaviour: Replace ordinary topic name regeneration with a Rename dialog containing the current title, Regenerate, Save and Cancel. Suggestions only fill the draft; explicit Save persists. Reject blank names, preserve drafts on errors, block duplicate submissions, and discard stale responses after edits or dialog/topic/runtime changes. Saved titles resist routine automatic naming. Closing without saving changes nothing.
Scope: Backend manual-title persistence and side-effect-free generation preview, Console dialog/controller/translations, API docs and regression tests. Preserve existing regeneration API, unrelated actions and TODO icon-only regeneration.
Decisions: Reuse existing dialog patterns and customization/revision safeguards. Trim input; preserve icons. TODO titles remain owned by their items. No extra dependencies.
Checking: Persistence/reload, automatic-name races, preview without mutation, regenerate-edit-save, cancel, validation, failure and stale-response tests; configured Go checks plus nsh checks/tests; browser focus/keyboard/mobile checks where available.

## factory · 2026-11-10 16:46
Built and pushed 7957bae6 and 704534a8; head: 704534a8. Moved new/ → review/ (round 1).
Implemented PUT topic title and POST title-suggestion APIs, manual-title revision/customization safeguards, and the Rename dialog with draft-only regeneration and stale-response protection. Added English/Chinese/Japanese text, API docs and regression tests. Names normalize whitespace and have a 72-character limit. Saving moves the topic to the top as previous regeneration did, preserves its icon, and leaves TODO icon regeneration unchanged.
Installs: none.
Verification: manager independently passed gofmt check, go vet ./..., go test ./..., nsh check and all 420 nsh tests. Initial manager UI test command hit its execution timeout; rerun with a longer timeout passed (6m40s). No forbidden paths changed; both commits are scoped to this item.
Coder browser checks: real Console with mock LLM in Chrome; preview does not persist, rename survives subsequent messages/restart, concurrent old regeneration returns 409; desktop focus, keyboard opening, Enter save, Escape discard and mobile touch-width sheet flow passed. A phone-width Chrome page closed once; rerun passed.
Not checked: real Android device/emulator and software keyboard, native desktop window, screen readers and iOS. Existing dialog focus limitation remains: Tab can leave the dialog after Save. Regenerate on phone-width view moves focus off input, which may hide the real phone keyboard. Review should examine these accessibility/platform limitations.
Push initially lacked repository-path credential context; retry using command-local credential.useHttpPath=true succeeded. No base branch or tag was pushed.

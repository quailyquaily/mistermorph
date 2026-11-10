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

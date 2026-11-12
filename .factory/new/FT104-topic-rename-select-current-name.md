# Select the current topic name when opening the rename dialog

## factory · 2026-11-13 08:24
Owner request: "When renaming topics, in the rename dialog, select the current name by default."

When the topic rename dialog opens, focus the name input and select the entire current name by default, so typing immediately replaces it. Apply this on every opening, including reopening the dialog or renaming a different topic. Preserve existing save and cancel behavior, and do not reselect text while the user is editing.

Acceptance checks:
- Opening the rename dialog prefills the current topic name, focuses the input, and selects all of its text.
- Typing replaces the selected name without requiring a manual select-all.
- Reopening the dialog selects the current name again.
- Save and cancel continue to work on desktop and mobile.

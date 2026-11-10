# Rename topic dialog UI fixes

## factory · 2026-11-11 01:01
Requested by the owner:

- Make the regenerate button icon-only, with no visible label; retain an accessible name.
- Match the regenerate button height to the topic-name input height.
- Make the Cancel and Save buttons equal in width.
- When the dialog closes, dismiss the on-screen keyboard too. Cover all supported close paths, including Cancel and successful Save, and ensure focus does not leave the hidden input active.

Scope: the rename topic dialog. Preserve existing rename and regenerate behavior.

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

# Fix mobile chat right-side panel tab styling and Android top safe area

## factory · 2026-11-09 05:56
Requested by the owner: in mobile view, the chat view's right-side panel has incorrect tab styling. On Android, this panel should also have a top safe area like the page top. Add this issue to new/.

Acceptance criteria:
- Inspect and correct the right-side panel's tabs in mobile chat view so their appearance matches the console's intended tab styling, including selected and unselected states, spacing, alignment, and touch targets.
- On Android, respect the top safe-area inset consistently with the page header, keeping panel tabs and content clear of the system status bar or display cutout.
- Avoid duplicate top padding when an enclosing layout already applies the inset; retain correct layout with zero insets.
- Preserve tab switching and panel opening/closing behavior, and avoid regressions in desktop layout and other mobile views.
- Add appropriate regression coverage and visually check the mobile panel, including Android with a nonzero top inset; explicitly record any checks that cannot be performed.

Scope: mobile chat right-side panel tab styling and Android top safe-area handling. The exact styling defect and its cause still need inspection; no diagnosis is assumed. Registered only; not implemented or visually verified.

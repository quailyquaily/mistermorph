# Fix button loading state not rendering in the web console

## factory · 2026-11-08 12:51
Owner report: "new factory UI bugs, on web console: the loading status of button, fail to render."

Investigate and fix button loading indicators that fail to render in the web console. The affected button and root cause have not yet been identified; inspect the shared button component and its loading-state callers rather than assuming a specific cause. This report is not restricted to desktop Chrome or mobile.

Acceptance criteria:
- Buttons with an active loading state visibly render their intended loading indicator for the duration of the pending action.
- Loading indicators remain visible with the console's supported button variants and themes, without unintended layout shifts.
- Loading clears correctly on both success and failure, preserving existing disabled-state and duplicate-submission behavior.
- Add regression coverage for loading-state rendering and transitions; verify representative buttons in the UI.

Registered only; not yet diagnosed or implemented.

## factory · 2026-11-08 13:28
Moved from new to backlog at the owner’s request: “move FT 26~29 to backlog”.

## lyric · 2026-11-08 18:04

FT29,28 放到 new

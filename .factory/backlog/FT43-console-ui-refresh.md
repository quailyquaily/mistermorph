# Console: apply the approved UI refresh

## lyric · 2026-11-09 09:21
Apply the approved UI design to the web UI (`web/console-nsh`, also drawn by the desktop shell). The spec, with live demos and every value, is `design/ui-refresh.html`; open it in a browser.

What it covers:
1. View toggles: the hairline under the Topics head sags softly under the active toggle (`TopicSidebar.tsx`).
2. Sidebar: the right edge bends in beside the active page (`components/frame/Sidebar.tsx`).
3. Messages: sent bubbles get 14 px corners with the tail corner kept at 2 px; agent replies stay plain text. The time and the status columns on one 11 px / 16 px line (FT33 shipped part of this; check what is left).
4. Phone bottom bar: iOS tab-bar style, same five slots, 28 px icons, active filled, no sliding rule (`components/frame/MobileBottomNav.tsx`).
5. Border beam as the loading state: on the composer while a task runs (idle composer unchanged), and on every busy button, which is also disabled; filled buttons turn soft. It replaces `LoadingStripes` (`components/ui.tsx`, `components/chat/ChatComposer.tsx`).
6. Status mark, Running only: the square morphs into a turning arc and back.

Rules: Aojashin only; restyle existing elements, add none; no background patterns. Not adopted items are listed at the end of the spec; leave them out.

nsh has no CSS masks or `offset-path`: the beam needs its own drawing (a gradient stroke along the rounded-rect path with an animated offset, plus a faint blurred copy), built once and shared by buttons and the composer. Check this first.

## factory · 2026-11-09 09:47
Moved to backlog: the required approved specification `design/ui-refresh.html` is absent from the fetched base (`3f056a84`) and factory_board. Claude Code independently checked the worktree and found no equivalent approved refresh specification. The live demos, remaining values, and explicitly excluded designs cannot be verified; implementing them would require inventing the approved design. Add the specification to the base and return this item to new to resume. No implementation commits, installs, or tests; no UI was changed or visually checked.

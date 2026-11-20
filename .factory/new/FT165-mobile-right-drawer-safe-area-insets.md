# Keep mobile right-side drawers clear of system bars and cutouts

## factory · 2026-11-20 09:30
Owner reports that most right-side panels in the mobile app overlap the system status bar and requests a fix.

### Required behavior
- Apply mobile safe-area insets to right-side drawers so headers, close controls, content, and bottom actions remain clear of the status bar, navigation bar, and display cutouts in portrait and landscape.
- Cover the shared SidePane (Settings detail panes, channel settings, Audit details, and other consumers) and the separate Skill Store detail drawer. Reuse the existing chat topic/workspace drawer's inset handling where appropriate; avoid adding duplicate padding to drawers that already handle it.
- Keep drawer backgrounds edge-to-edge where intended, while keeping interactive content inside the safe area. Preserve scrolling, sizing, and on-screen keyboard behavior.
- Preserve desktop layout and mobile-web behavior; use the application's existing native/CSS inset sources rather than hard-coded status-bar heights.

### Investigation context
- Prior Claude code inspection identified missing inset handling in `web/console-nsh/components/ui.tsx` (SidePane) and `web/console-nsh/pages/skills/SkillStorePage.tsx`; `web/console-nsh/pages/chat/WorkspacePanel.tsx` provides an existing working pattern. Verify current code before implementing.
- Android overlap was identified from code, not a device test. iOS behavior has not been verified; inspect its inset path and explicitly report any remaining verification gaps.

### Acceptance checks
- Add regression coverage for shared and separate drawer inset handling, zero/nonzero safe areas, and avoiding double padding.
- Check Settings (including channel details), Audit details, Skill Store details, and the existing workspace drawer for readable headers, usable close buttons, scrolling, and reachable bottom controls.
- Check portrait/landscape, system navigation modes, keyboard open/closed, and desktop regressions. Record which native/device scenarios were actually tested; do not claim device verification from source inspection alone.

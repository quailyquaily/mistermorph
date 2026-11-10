# Fix FT56 topic tag assignment in the Android app

## factory · 2026-11-11 00:52
Registered from the owner's request: "FT56 doesn't work on Android app. Need to inspect and fix. Add to new"

Follow-up to done/FT56-console-topic-list-drag-drop-tags.md, shipped in v0.3.93. Keep FT56's completed release history intact. The owner reports the feature does not work in the Android app; the precise failing gesture and root cause have not yet been reproduced or established.

Inspect the Android app's native touch/gesture path for dragging a topic onto a named tag group. Reproduce the failure, identify the cause, and fix tag assignment on Android rather than assuming desktop or headless browser results prove native support. Preserve normal list scrolling, topic opening, and the existing tap-based tag editor. Define a deliberate touch activation gesture so dragging does not accidentally assign tags during scrolling.

Acceptance:
- Android users can assign a named tag to the intended topic with the supported drag interaction; valid-target feedback appears and clears on drop or cancellation.
- Successful assignment persists after reopening/reloading and updates both the list and topic tag display; unrelated tags are preserved and duplicates are no-ops.
- Invalid targets, pseudo groups, cancelled gestures, and scrolling do not write tags; persistence errors are visible.
- Existing desktop drag-and-drop and tap-based tag editing continue to work.
- Add regression coverage for Android touch activation, scrolling versus dragging, success, cancellation, invalid targets, and persistence failure. Run repository and Console checks.
- Verify in an actual Android app runtime (device or emulator), recording environment and reproduction/verification steps. If unavailable, explicitly report that limitation; do not claim native verification from headless web tests alone.

Implementation, when scheduled, must use Claude Code, not Codex. This entry only registers investigation and repair; no reproduction or fix has been performed yet.

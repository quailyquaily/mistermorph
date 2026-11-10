---
branch: factory/FT80-android-topic-tag-drag-drop
round: 1
---
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

## factory · plan · 2026-11-11 06:38
Behaviour: In tag view, deliberately hold a topic on touch screens then drag onto a named tag group. Preserve immediate swipe scrolling and taps; show valid-target feedback and clear on drop/cancellation. Empty lists, missing measurements, invalid/pseudo targets and duplicate tags write nothing. Use the existing persistence/error path and preserve unrelated tags.
Scope: Console gesture adapter, sidebar integration, regression tests and native-runtime compatibility notes; no backend redesign or changes to FT56 history.
Decisions: Use a 450ms stationary hold within 8pt on touch, preserving desktop's existing drag threshold. Inspect nsh native gesture handling instead of assuming DOM drag support. Keep tap-based tagging available.
Checking: Activation timing, scrolling versus dragging, success, cancellation, invalid groups, duplicates, persistence failure and desktop regressions. Run Go and Console checks. Verify on an actual Android runtime if available; otherwise explicitly record the gap and manual steps.

## factory · 2026-11-11 06:38
Built with Claude Code; pushed f2d43340 on factory/FT80-android-topic-tag-drag-drop. Root cause: topicDrag.handlers returned no handlers on non-desktop platforms. Added timed touch activation, native responder takeover on movement, cancellation and press suppression; retained normal swipes/taps and existing tag persistence. Leaving tag view or removing the row cancels a drag. Touch tooltip structure remains stable during gestures. Added 12 regression tests and PORTING.md native implementation notes.
Tests: Manager independently passed gofmt cleanliness, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js (536 passed, 0 failed). Initial manager Console run hit a 10-minute execution timeout; a complete rerun passed in 10m10s. Coder also reports successful nsh build and Android APK build using existing pinned tools. Installs: none.
Not checked: no actual Android device/emulator, adb, emulator binary or /dev/kvm available; UI was not visually inspected in a native runtime. Headless Android-mode tests are not native verification. Native scroll interception/event timing remain unverified; a fast first move after holding may let scrolling win and cancel without writing. No edge autoscroll; offscreen groups cannot be reached in one drag.
Manual native verification: build/install APK, open tag view, compare swipe/tap with a 450ms hold followed by dragging onto another named group; verify target feedback, preserved tags and persistence after reopening. Release without movement, cancel/Back, flick after hold, drop outside/on pseudo groups/on an existing tag: no writes. Simulate persistence failure and check visible error; also verify desktop drag and tap tag editing.
Push initially required command-local credential.useHttpPath=true; retry succeeded. Moved new/ → review/ for review, not released.

## factory · review · 2026-11-11 06:53
head: f2d433405fe710cd03b21385a4107e0d293f1f3b
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD; no confirmed P0/P1 findings. All four changed files reviewed; worktree remains clean. Branch merges cleanly with current master.
- Residual risk at web/console-nsh/pages/chat/topicDrag.ts:254-258,320: the native scroll view may intercept the first vertical move after the 450ms hold before JS claims the responder. Example inferred from runtime code: 5dp drift during hold then 8dp movement can cross native touch slop and cancel the lifted row without assigning a tag. Coder rated this P2, but it was not reproduced on a device; retained as an unverified risk rather than a confirmed defect. Consider disabling scroll when the hold activates and verify on Android.
- Tests passed: gofmt cleanliness, go vet ./..., go test ./..., nsh check, nsh test --web-host tests/noHost.js (536 passed, 0 failed, 10m14s). Tests used an isolated HOME; manager checked recorded exit markers. Installs: none.
- Actual Android device/emulator verification remains unavailable; headless tests do not establish native gesture behavior. Touch-specific end-to-end persistence success/failure coverage remains incomplete; shared desktop persistence tests exist. Mobile browser behavior was not verified. Owner should inspect the native hold-to-drag interaction before release.
- No linked GitHub issues or PRs. Moved review/ → ready/ under factory policy (no P0/P1); not merged or released.

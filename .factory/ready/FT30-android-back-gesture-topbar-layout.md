---
branch: factory/FT30-android-back-gesture-topbar-layout
round: 1
---
# Fix Android swipe-back navigation and topbar layout

## factory · 2026-11-08 18:02
Requested by the owner in Console: “android 版本有个问题，无法左滑返回，然后 topbar 在 Android 上的尺寸和位置也不正确。加到 factory new 吧。”

Reported problems:
- On Android, the owner's expected swipe-back gesture (described as 左滑返回) does not navigate back.
- The topbar's size and position are incorrect on Android.

Expected outcome:
- Investigate the Android navigation gesture handling and restore expected back navigation. Confirm the gesture direction and edge behavior against existing navigation and Android conventions rather than assuming a new opposite-direction gesture is required.
- Correct topbar height, positioning, and system-bar/safe-area spacing on Android; prevent overlap, clipping, or doubled insets.
- Preserve existing iOS and desktop navigation and layout behavior.

Checking:
- Add regression coverage for back navigation and Android topbar inset/layout handling where practical.
- Check Android portrait and landscape layouts, navigation into and back out of a detail view, and interaction with scrolling and the keyboard.
- Record the Android environment tested. If physical-device gesture or visual checks cannot be performed, explicitly record those limitations rather than claiming verification.

## factory · plan · 2026-11-08 18:29
Behaviour: Diagnose Android host/router/topbar. Route native system Back through existing detail navigation and session history, keeping root exit and modal priority. Apply status/navigation/side insets once, including first launch, rotation and keyboard changes.
Scope: Native console-nsh platform, router, shell and focused regression tests. No global web typography or iOS redesign.
Decisions: Use Android's native edge-swipe/button Back callback, not a custom opposite-direction swipe. Reuse runtime safeArea values and existing page back actions.
Checking: Detail/root/modal/menu Back and Android portrait/landscape/keyboard inset regression tests; required Go checks; native frontend suite/check/build. Record missing device/visual verification explicitly.

## factory · 2026-11-08 18:29
Built f4482025 from master 8b613ef1. Registered Android BackHandler while a page action or session history is available. Detail back actions and menus run before history; root returns control to Android. Added mobile session history, root/overlay safe-area padding and bottom navigation/keyboard inset allocation. Updated English documentation and Android regression coverage.
Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with throwaway HOME. Coder reports full console-nsh suite 258/258 before final added test, final Android file 10/10, nsh check/build, web build and core tests 245/245 passing. Vue console unchanged.
Install: coder installed androguard==4.1.2 in a temporary virtual environment to inspect the nsh 0.4.0 Android runtime; no repository dependency changes. Process deviation: that environment was outside the designated build directory, contrary to the requested work boundary.
Not checked: no Android SDK, adb, emulator or physical device available; no APK build or visual/device gesture verification. Portrait/landscape and keyboard coverage checks inset calculations, not actual rendered geometry or software keyboard interaction. Existing native side-sheet touch-offset concern remains unverified and unchanged. Owner/reviewer should check Android device navigation, topbar geometry, keyboard and native sheets.
Moved new/ → review/. No base merge or deployment.

## factory · review · 2026-11-08 18:48
head: f4482025f57d5554deb045684df4a5834ed77fd4
verdict: pass
notes:
- [P2] web/console-nsh/pages/settings/SettingsPage.tsx:132: System Back hides the editor before the leave confirmation completes. Reproduced Settings list → Tools → change toggle → system Back → Keep editing: URL remains /settings/tools but controls disappear and the list is shown. Hide the panel only after navigation is approved; preserve it on cancellation.
- [P2] web/console-nsh/pages/context/ContextPage.tsx:236: The topbar back arrow still pushes history, unlike the new system Back handler. Reproduced restored Context → topbar Back → system Back to topic list → system Back: Context reopens. Reuse the system Back history/replace behavior for Android's topbar arrow.
Validation: Codex reviewed all 18 changed files in origin/master...HEAD (base 8b613ef1). Required gofmt/vet/Go tests passed. nsh typecheck and bundle build passed; nsh tests passed 259/259 across 34 files run individually after directory-entry discovery failed; pure logic tests passed 245/245. Two additional isolated regression assertions failed and confirmed the P2 findings above. No P0/P1 found; pass is the factory threshold, not an absence of defects.
Limits: nsh web packaging could not complete because the web runtime is absent. No Android device/emulator, physical gesture, portrait/landscape geometry, keyboard, or iOS/desktop visual verification. Vue console sources unchanged. Tests used isolated copies and throwaway HOME inside the review directory. No unpinned installs, source edits or code commits. Branch merges cleanly with origin/master. No linked GitHub issue or PR.
Moved review/ → ready/. Owner should inspect both P2 defects and verify Android device behavior before ship.

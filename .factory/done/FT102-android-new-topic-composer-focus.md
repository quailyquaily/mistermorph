---
branch: factory/FT102-android-new-topic-composer-focus
round: 1
---
# Focus the composer when opening a new topic in the Android app

## factory · 2026-11-13 00:39
Owner request:
> New UI fix:
> The new topic page, on the Android app, when entering the page, the keyboard popped up, but failed to focus on the composer.
> To the new status

### Expected behavior
- Fix the Android app's new-topic entry flow: when the page automatically opens the soft keyboard, the topic composer must actually receive editable focus and accept typing immediately.
- Coordinate composer readiness, page transition, focus, and keyboard presentation so the keyboard is not shown while the composer remains unfocused.
- Keep focus stable through the initial keyboard/viewport resize and any initial composer render; do not repeatedly steal focus after the user selects another control or dismisses the keyboard.
- Preserve existing draft handling, topic creation, sending behavior, and intentional autofocus behavior on other platforms and existing-topic pages.

### Acceptance checks
- In the Android app, enter the new-topic page from the usual entry points: the composer has a visible caret and typing immediately inserts text without an extra tap.
- Repeat after leaving and reopening the page, including with an existing draft; verify no lost text, duplicate input, or focus jumps during entry.
- Verify dismissing the keyboard or focusing another control does not trigger unwanted refocus or keyboard reopening.
- Add regression coverage for focus timing/readiness as appropriate and run configured repository and Console checks/tests.
- Verify on an Android device or emulator; if unavailable, explicitly report that limitation rather than claiming the native keyboard behavior was verified. Check that desktop/mobile-web behavior is unchanged.

Scope: Android new-topic composer focus and keyboard coordination; no composer or navigation redesign. The observed cause is not yet confirmed.

## factory · plan · 2026-11-13 04:30
### Behaviour
A new-topic entry focuses the editable composer after the view is ready and, on native phone apps, after its pane arrives. Keep the focus through the initial keyboard resize; request once, without retries. Cancel pending requests when navigating away, selecting another topic, sending or no longer eligible. Preserve drafts and caret placement, read-only guards and existing-topic mobile behaviour. An absent or unmounted field must not raise a keyboard.

### Scope
Android new-topic composer focus timing, the pane restacking that removes native focus, and focused regression tests. No navigation/composer redesign or unrelated changes.

### Decisions
Use lifecycle/transition readiness rather than arbitrary retries. Keep web focus close to the initiating user gesture. Only the exiting pane changes stacking order, so the arriving pane is not detached/reinserted at slide completion. The new-topic request waits one microtask for reactive rendering, then waits for native pane arrival. No repeated autofocus.

### Checking
Regression coverage for delayed arrival, reopening with a draft, viewport resize, cancellation/back navigation, opening a sheet, existing-topic mobile behaviour, desktop entry and stable pane z-order. Run the repository Go gate and Console check/full suite. Native keyboard acceptance requires an Android device or emulator; report unavailable rather than claiming verification.

## factory · 2026-11-13 04:30
Built in c2b58560 and 7558fece; head: 7558fece455f07de61e2338b95c5457b3a3ce97f.
- Found two focus losses: changing the arriving pane's zIndex restacked its native view at slide completion, and immediate startNewTopic focus could target the previous composer before reactive rendering.
- PaneStack now changes only the exiting pane's zIndex; added one-shot cancellable entry focus and guards against focusing an unmounted/read-only composer. Added 12 regression tests and documented runtime traps in English.
- Tests: repository gofmt/vet/go-test gate passed; nsh check passed; full Console suite passed, 828/828, with repository-pinned nsh 0.5.0/runtime and a throwaway HOME. Manager's initial verification accidentally used installed nsh 0.4.0 and failed 60 tests; rerun with 0.5.0 passed without source changes.
- Installs: no new installs reported or evidenced; reused existing pinned nsh 0.5.0/runtime and existing browser tooling. No manifest or lockfile changes.
- Browser probe/screenshot artifacts cover a narrow touch viewport with typing. Android device/emulator and native soft-keyboard behaviour were NOT verified; desktop/mobile-web visual acceptance was not comprehensively checked. Owner should inspect Android new-topic entry, draft reopening, keyboard dismissal and focus stability on hardware.
- Manager verified commits are confined to this item's Console code/tests/docs and no protected paths changed. Branch pushed; moved new/ → review/.

## factory · review · 2026-11-13 05:31
head: 7558fece455f07de61e2338b95c5457b3a3ce97f
verdict: pass
notes:
- Claude Code reviewed all nine changed files against origin/master (8b021ee4); no confirmed P0/P1/P2/P3 findings. Verified native restacking semantics against pinned nsh 0.5.0 sources and reviewed transition ordering, cancellation, stale/read-only composer guards and draft caret preservation.
- Validation: gofmt/vet/go-test gate passed; nsh check passed; final full Console run passed 828/828 with pinned nsh 0.5.0 and a throwaway HOME. Initial Console run passed 827/828, with android-voice.test.tsx failing: "no pressable view matches label:Voice input". Targeted repeats and source tracing indicated load-sensitive async route readiness outside this change; final idle full rerun passed. This transient failure remains a validation caveat, not a confirmed introduced defect.
- Installs: none; reused existing pinned tooling. Reviewer changed no tracked files or commits; manager confirmed clean worktree and unchanged head.
- Not verified: Android device/emulator/native keyboard/caret behaviour, browser or desktop visual acceptance. Headless tests cannot reproduce native restacking focus loss. Owner should check Android entry, draft reopening, keyboard dismissal and focus stability on hardware.
- Residual uncertainty: selecting a non-popup, non-composer control during the initial slide was not reproduced; no confirmed defect reported. No linked GitHub issue or PR in the item.
- Moved review/ → ready/; no merge or deployment performed.

## factory · 2026-11-13 08:37
Shipped ready/ → done/ on owner approval after current-head passing reviews and combined-base validation with Claude Code.
- Merge commit: 221045510e118e4d2c8a5422a331216ca3f3309a; released in v0.3.105, master head 588ad961617622bb1736cad1affe1ac4de56b721. Master and tag pushed atomically.
- Final checks: gofmt clean, go vet ./... passed, go test ./... passed; pinned nsh 0.5.0 check passed; full Console suite 851 passed, 0 failed. Scripted tests used an absolute throwaway HOME.
- No merge conflicts, unpinned installs or protected-path changes. No linked GitHub issues/PRs to close. Branch retained (clean is not configured).
- Real Android/native desktop and fresh full-app visual verification were not performed; prior review limitations remain.
- Additional test-only fix 910e8516777f797e291bb0e0886db10cef7b2c3c makes the mid-slide sheet test deterministic using slowSlides; six repeated passes and a guard-removal negative check. No application-code fix during shipping.

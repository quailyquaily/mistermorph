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

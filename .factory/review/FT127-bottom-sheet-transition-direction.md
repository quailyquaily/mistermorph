---
branch: factory/FT127-bottom-sheet-transition-direction
round: 1
---
# Fix bottom-sheet transition direction

## factory · 2026-11-15 14:05
Owner request from Console:

> UI fix:
> All bottom sheets transition direction is wrong, should slide in from the bottom, not from the top.
> Add to new/

Requirements:
- Audit all bottom-sheet variants and their shared transition styles in the Console, including mobile web and Android.
- Opening a bottom sheet must slide it upward from below the bottom edge into its resting position, never downward from the top.
- Closing must reverse that motion, sliding downward out of view.
- Preserve backdrop behavior, safe-area spacing, dismissal interactions, and reduced-motion support; do not change unrelated top sheets, dialogs, or popovers.
- Add regression coverage for opening and closing direction across the affected sheet variants. Visually verify the transitions where tooling permits, and record any platforms not checked.

## factory · plan · 2026-11-15 15:15
Behaviour: First opening starts below the bottom edge and travels upward to rest; closing travels downward out of view before unmounting. Reopening during exit reverses from the current position. First layout uses a full-layer fallback; measured positions then determine travel. Preserve empty/tall content, safe areas, dismissal and reduced motion.

Scope: Audit shared mobilePopupEntrance geometry and consumers: More/agent sheets, narrow Modal/MessageDialog/SettingDialog and PopupSheet dropdown/picker/composer consumers. Leave wide dialogs, unrelated top sheets and popovers unchanged.

Decisions: Correct the shared measured displacement rather than duplicate animations per consumer. Use positive below-bottom travel and rename misleading fromAbove state; preserve timings, scrims and interrupted transitions.

Checking: Regression coverage for positive-to-zero entry and zero-to-positive exit across sheet variants, reduced motion and interrupted reopen. Run nsh check, the required parallel Console test script, and gofmt/vet/all Go tests with throwaway HOME. Visually inspect mobile web where available and record unavailable platforms.

## factory · 2026-11-15 15:15
Built and pushed `factory/FT127-bottom-sheet-transition-direction` at `6f371501e2f7e26c10f76b2f15e8ec4aba329acc` (round 1). Moved new/ → review/.

Changed shared mobilePopupEntrance to positive below-bottom displacement with safe pre-layout fallback; all shared sheet consumers now rise on entry and descend on exit. Corrected state names, comments and popup docs. Added entry/exit, interrupted reopening and reduced-motion regression coverage, including small test probe hooks. No unpinned installs or manifest/lock changes. The owner's “Add to new/” was board intake wording, not a code change.

Checks: nsh check passed. Required Console parallel runner passed: 122 files, 0 failed (254 s); chat-attachments failed concurrently and passed on isolated rerun. An earlier full run failed this flaky test on its isolated rerun too; coder reproduced 2/8 concurrent failures on untouched base and left it unchanged. Affected regression files: 41 tests passed. gofmt/vet/go test ./... passed in coder run and independently in manager verification; scripted tests used throwaway HOME.

Visual: coder checked the real mobile web build in headless Chrome touch emulation at 390×844, 844×390 and reduced motion: More, agents and composer add menu move from/to the bottom correctly. Not visually checked: Android device/emulator, iOS, desktop app and other dialog sheets (headless coverage only).

Push initially failed because the credential request lacked repository path; retry with command-scoped credential.useHttpPath=true succeeded. No base branch or tags pushed.

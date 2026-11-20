---
branch: factory/FT164-gate-keyboard-shortcuts-by-platform-and-keyboard
round: 1
---
# Gate all keyboard shortcuts and their Settings page by platform and external keyboard availability

## factory · 2026-11-20 09:25
Owner clarifies that this applies to all application keyboard shortcuts and the Shortcuts page in Settings, not just Enter-to-send.

### Required behavior
- Enable application keyboard shortcuts and show their Settings entry/page only on desktop-view web, desktop apps, and mobile apps with an external physical keyboard connected.
- Hide the Shortcuts Settings entry/page and disable application shortcut handling on mobile-view web, including when a physical keyboard is present, and on mobile apps without an external keyboard. Do not use web key-event heuristics to grant mobile-web eligibility.
- Use one shared eligibility decision for shortcut execution, shortcut hints/discovery UI, and the Settings entry/page, so hidden shortcuts cannot still fire. Guard direct navigation to the page when ineligible.
- On mobile apps, obtain physical-keyboard availability from the native host; initialize and refresh it on connection/disconnection and app resume. Unknown or unsupported detection must not enable shortcuts. Do not infer physical keyboard presence merely from a hidden on-screen keyboard.
- Reevaluate eligibility when web layout switches between desktop and mobile views and when a mobile app's physical keyboard connects/disconnects; update both behavior and UI without requiring a reload. Desktop apps remain eligible regardless of window width.
- Preserve ordinary text input, IME composition, accessibility, and OS/browser-native shortcuts. Audit application shortcut entry points, including composer keyboard actions, so none bypass the shared policy; keep non-shortcut input behavior intact.

### Acceptance checks
- Cover desktop-view web, mobile-view web with and without external keyboards, desktop apps at wide and narrow widths, and mobile apps with connected/disconnected/unknown physical-keyboard state.
- Test runtime layout changes, native keyboard connection/disconnection and resume updates, direct Settings-page navigation, and that disabled application shortcuts neither execute actions nor consume normal input events.
- Record platform detection limitations and any native bridge work needed; do not claim hardware scenarios were verified without testing them.

## factory · plan · 2026-11-20 10:29

Behaviour: A shared reactive eligibility decision enables application shortcuts only on desktop web layout, desktop native regardless of width, and native mobile with positively known connected hardware keyboard. Mobile web is always excluded. Unknown native state fails closed. Native initialization, keyboard changes and resume refresh state; layout changes immediately update execution, discovery/hints and Settings entry and direct route. Ineligible key events retain normal text/IME/accessibility and native behavior.
Scope: Audit every Console shortcut binding, composer actions and hints; gate all application shortcuts and Settings shortcuts routing with the same policy. Add native host keyboard support where this repository owns it, without touching external dependency sources. Keep ordinary editing/navigation intact and existing shortcut preferences unchanged. Document unsupported platform gaps honestly.
Decisions: Use explicit native host keyboard state, never key-event or virtual-keyboard heuristics. Prefer the existing shell layout signal and platform abstraction. Unsupported native bridge yields unknown/ineligible, with limitations documented; implement owned Android bridge if feasible and available. No invented device verification.
Checking: Add regressions for desktop/mobile web, native desktop at narrow/wide widths, native mobile known/unknown state; live resize, native connect/disconnect/resume, direct route guard, input events not consumed, composer behavior and hints. Run nsh check, Console scripts/test.sh and configured Go test command. Record device scenarios not tested.

## factory · 2026-11-20 10:29

Built f39cb23f: shared reactive shortcut eligibility gates dispatch, composer actions, hints and Settings navigation. Android native keyboard bridge refreshes on device/configuration/resume events; unsupported iOS detection remains unknown and disabled. Focused-control and popup key handling remains available. Added 21 eligibility regressions and Android host tests; documented detection limitations.

Checks: nsh check passed; prescribed Console runner passed all 146 files; Android JVM tests and SDK Java compilation passed (coder report). Manager independently reran configured gofmt/vet/Go tests successfully. No installs or manifest changes.

Not checked: real browser UI/IME, physical keyboards, emulator/device, iOS, or APK build. Native detection may count misreporting alphabetic accessories; first boot host call failure is not retried until restart. Review should inspect native state refresh and keyboard classification.

Coder reported an unauthorized tooling-memory append outside the build directory; manager did not access or change that outside file. Board move initially omitted metadata due to a manager script error; this follow-up records the missing header, plan and build results without rewriting history.


## factory · review · 2026-11-20 10:54
head: f39cb23f46c137d2eca18499e2bcd04fb3dd0060
verdict: pass
notes:
- [P2] web/console-nsh/components/ui.tsx:885: the new shared gate only covers bindPaneEscape; SkillsPage.tsx:533 and ContactsPage.tsx:747 still bypass shortcutsEligible(). Verified headless examples: mobile web 390x844, open skill + Escape closes detail; native Android 1280x800 with disconnected/unknown keyboard, Right then Enter opens contact and Escape closes it. Gate both page bindings with the shared policy and add regressions. These are limited navigation defects, not P0/P1; factory pass does not mean no findings.
- Configured gofmt/vet/Go tests passed. nsh check passed; prescribed Console test runner passed all 146 files after its automatic solo retries of six initially failing files. Node library tests 280/280 and Android manifest tests 11/11 passed. No installs or manifest changes; worktree remained clean.
- Android JVM/SDK compilation not rerun: Java/JDK unavailable to this reviewer. No device/emulator/browser UI/IME/physical keyboard or APK verification. Headless stubs cover state updates; device classification and boot-time event ordering remain unverified.
- Reviewed origin/master...HEAD, all 30 changed files, with Claude Code. No P0/P1 findings; moved to ready per factory policy. Owner should inspect the P2 shortcut bypass before shipping.

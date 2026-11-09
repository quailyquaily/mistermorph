---
branch: factory/FT41-console-mobile-composer-popups-keyboard
round: 1
---
# Keep mobile composer plus and profile popups clear of the keyboard

## factory · 2026-11-09 07:04
Owner report: typing in the mobile composer opens the keyboard; clicking the plus button or profile button opens a popup that is covered by the keyboard. These popups must not be covered. Requested status: new/.

Acceptance criteria:
- Reproduce with the mobile composer focused and the software keyboard visible, for both the plus-button popup and the profile-button popup.
- Ensure either popup remains visible and its actions reachable when opened from this state, using the existing mobile layout and keyboard conventions. Dismiss the keyboard or adapt popup placement as appropriate rather than allowing overlap.
- Preserve the draft, popup interactions, dismissal, and subsequent composer focus/typing behavior.
- Respect safe-area insets and avoid regressions when the keyboard is hidden or on desktop.
- Add regression coverage for both popups and check mobile keyboard-visible behavior, including Android. Explicitly record device checks that cannot be performed.

Scope: mobile composer popup/keyboard interaction; no root cause or specific implementation is assumed.

Registered only; not diagnosed, implemented, or visually verified.

## factory · plan · 2026-11-09 09:21
Behaviour: opening either composer popup with the mobile keyboard visible must leave its actions reachable. Preserve draft and caret, dismissal and subsequent typing; preserve empty/single-profile and disabled/uploading states.
Scope: composer popup/keyboard handling and focused tests only; no unrelated layout changes.
Decisions: inspect nsh's supported APIs and prefer keyboard dismissal over unsupported placement changes; retain existing safe-area conventions and desktop behavior.
Checking: regressions for both popups, keyboard-hidden and desktop cases, draft/focus restoration and Android safe-area bounds. Run repository and Console checks; explicitly report unavailable physical-device checks.

## factory · 2026-11-09 09:21
Built and pushed `90c179eb`: touch-screen plus and profile sheets dismiss the keyboard using Keyboard.dismiss(). Cancellation and model selection restore prior composer focus/caret; Upload and Attach leave focus to their next surface. Profile search applies a bounded keyboard lift. Added five regression tests and documented the nsh sheet behavior.
Decision: nsh touch menus use bottom sheets regardless of top placement, so dismiss the keyboard rather than reposition anchored menus. Existing desktop behavior is retained.
Installs: none.
Checks: gofmt clean; go vet ./... and go test ./... passed. nsh check passed; coder's nsh build passed. Manager independently reran Console tests: 290 passed, 0 failed. Initial combined verification hit the shell time limit during Console tests; standalone rerun completed successfully. Scripted verification used throwaway absolute HOME paths.
Not checked: no visual UI inspection on real Android, emulator or mobile browser; no Android SDK/emulator available. Headless Android checks verify focus rather than rendering a software keyboard. Owner should verify visible keyboard dismissal/restoration, safe areas, and profile-search sheet position on a physical Android device (including possible double lift by native sheet behavior).
Moved new/ → review/; not merged into master.

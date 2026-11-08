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

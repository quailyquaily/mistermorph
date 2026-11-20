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

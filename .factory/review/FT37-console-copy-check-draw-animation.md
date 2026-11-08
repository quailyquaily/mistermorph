---
branch: factory/FT37-console-copy-check-draw-animation
round: 1
---
# Animate the chat copy confirmation check as a drawn stroke

## factory · 2026-11-09 05:44
Requested by the owner: the copy button below the chat bubble should animate its confirmation check icon as though a person is drawing the check, instead of the current zooming-out effect. Add this improvement to new/.

Acceptance criteria:
- After a successful copy, progressively reveal the check stroke in drawing order: the short downward stroke followed by the longer upward stroke.
- Keep the icon at a stable size; replace the zoom/scale effect rather than combining it with the drawing animation.
- Preserve clipboard behavior, confirmation timing/reset, and repeat-copy behavior. Do not show success when copying fails.
- Respect reduced-motion preferences with a static confirmation check.
- Verify the animation on the chat-bubble copy control and add appropriate regression coverage.

Scope: the copy button below chat bubbles; no unrelated button or chat layout changes. Registered only; not implemented or visually verified.

## factory · plan · 2026-11-09 06:04
Behaviour: Idle, empty and failed copies keep their existing behaviour. Successful copy draws the short downward check stroke then the long upward stroke at fixed size. Each successful repeat restarts drawing; the existing 1200 ms expiry restores the copy icon. Reduced motion shows the full check immediately.

Scope: ChatHistoryItem CopyButton, a small check geometry helper and focused regression tests. No unrelated controls, layout, or clipboard controller changes.

Decisions: Use cross-platform nsh Canvas and native animated values, not DOM-only SVG/CSS. Replace scaling/pop/ring with a roughly 300 ms stroke draw at the existing 14pt size.

Checking: Stroke geometry/order, restart/reset/reduced-motion states, clipboard behaviour, nsh check and complete nsh tests, plus configured formatting/vet/Go tests. Attempt visual verification and record any limits.

## factory · 2026-11-09 06:04
Built and pushed commit 5523b1db. Replaced copy feedback scaling and expanding ring with a 320 ms Canvas check stroke; retained the existing icon shape, size, clipboard controller, and reset timing. Repeated copies restart drawing; reduced motion and re-bound copied rows show a complete check. Added geometry/state and chat integration regressions, with manual-clock/reduced-motion support in the test harness.

Installs: none. Used the existing nsh 0.4.0 distribution; no dependency manifests or lockfiles changed.

Tests: Manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`, `nsh check`, and `nsh test --web-host tests/noHost.js` (290 passed, 0 failed), with an absolute throwaway HOME. Only four in-scope files changed and no protected paths changed.

Not checked: The actual chat-bubble animation was not visually verified in a live Console. Coder reports a temporary Chrome fixture using the same geometry/Canvas calls showed ordered drawing and static reduced-motion confirmation; this does not verify the real control. Desktop and Android were not run. Clipboard failure was not induced; its controller path is unchanged. Owner/reviewer should inspect the actual chat control's animation, including repeated copy and reduced motion.

Moved new/ → review/.

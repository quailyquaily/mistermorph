---
branch: factory/FT23-console-mobile-bottom-nav-alignment-avatar
round: 1
---
# Fix mobile bottom navigation alignment and avatar styling

## factory · 2026-11-08 11:50
Requested by the owner in Console: add a new Factory request for the mobile view.

Owner's request:
> 1. The bottom nav item padding is wrong. Need to make sure the icon is in the middle.
> 2. The last bottom nav icon, the agent avatar, when click this item, no need to draw a circle on the avatar. Btw, no need to draw a blue square at the avatar as well.

Requirements:
- Fix mobile bottom navigation item padding/alignment so each icon, including the agent avatar in the last item, is centered horizontally and vertically within its navigation item.
- Remove the extra circular decoration drawn over/around the agent avatar when its item is clicked or selected.
- Remove the blue square background/decoration at the avatar. Keep the avatar itself and its intended image shape unchanged.
- Apply the avatar treatment consistently in idle, pressed, and selected states; do not remove accessible keyboard focus indication (use a suitable focus-visible treatment if needed).
- Preserve navigation behavior, accessible labels, touch target sizes, and bottom safe-area handling. Limit styling changes to mobile bottom navigation; do not change desktop navigation unintentionally.

Acceptance checks:
- Inspect narrow mobile widths in supported light/dark themes: all icons sit centrally with balanced padding and no clipping.
- Tap/select the last navigation item: navigation still works, with neither the unwanted circle nor blue square on the avatar.
- Verify keyboard focus remains visible and add regression coverage appropriate to the existing Console test setup.

Request registered only; implementation and visual verification are pending.

## factory · plan · 2026-11-08 12:18
Behaviour: Center every mobile navigation icon and portrait in its cell. Idle, pressed and selected agent portraits have no added ring, status square or blue press fill. Preserve keyboard focus, labels, navigation, safe-area handling and the empty portrait fallback; first-run and error behaviour remain unchanged.

Scope: Mobile bottom navigation CSS, agent trigger markup and focused regression tests. Desktop navigation and switcher list statuses are out of scope.

Decisions: Remove the trigger status decoration and active portrait shadow, retain the portrait crop, switcher list status indicators and top active-slot rule. Correct row sizing rather than add visual offsets.

Checking: Add node regression coverage, run Console tests/build and configured Go checks. Inspect narrow widths and focus/pressed/selected states where tooling permits; explicitly record visual limitations.

## factory · 2026-11-08 12:18
Built and pushed commits 44b60bd8 and f616b9c7. Navigation cells now fill the row inside the border and safe area, removing the 1px overflow and 0.5px vertical offset. The agent trigger retains its portrait without the status square, selected ring or pressed fill; keyboard focus remains visible. Desktop and menu status indicators are unchanged.

Tests: Manager independently verified gofmt check, go vet ./..., go test ./..., pnpm test (486 passed) and pnpm build. Build retains the existing large-chunk warning. Six new regression tests; coder reports three fail on the previous implementation.

Installs: No unpinned tools or dependencies; restored locked pnpm dependencies only.

Visual checks: Coder measured the real component in a static headless-Chrome harness at 375px and 320px, including a simulated 34px safe area and idle/pressed/selected/focus states; centering within 0.01px and no overflow. Not checked in the running application or on physical iOS/Android devices. Only the existing light theme was checked; no separate dark theme exists. Empty portrait fallback is markup-tested, not visually checked; the offline screenshot had a harness-only broken logo. Review should inspect the mobile navigation in the actual application.

Moved new/ → review/.

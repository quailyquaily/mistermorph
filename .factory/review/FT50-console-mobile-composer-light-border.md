---
branch: factory/FT50-console-mobile-composer-light-border
round: 1
---
# Add a subtle design-consistent border to the mobile composer

## factory · 2026-11-10 00:31
Owner request (mobile views): "The composer should have a light border, fit our design."
Requested status: new/.

Acceptance criteria:
- Give the mobile composer a subtle visible border consistent with existing design tokens, shape, spacing and supported themes.
- Preserve focus and disabled states, input sizing, multiline growth and button alignment; avoid layout shifts.
- Check narrow mobile widths with the keyboard both open and closed; do not introduce unrelated desktop styling changes.
- Add focused regression coverage where practical; record any mobile/device checks that could not be performed.

Registered only; not diagnosed, implemented, or visually verified.

## factory · plan · 2026-11-10 01:58
Behaviour: On mobile, show a subtle visible composer outline from first render, including empty, disabled, error and attachment states. Preserve existing focus treatment and keyboard layout.
Scope: Composer frame styling and focused regression coverage only; no desktop restyling or theme redesign.
Decisions: Reuse an existing design token at the application's mobile breakpoint, with constant 1pt geometry and unchanged focus override. Inspect the existing border-input rather than adding a second frame.
Checking: Mobile/desktop border regression, layout/focus/read-only/multiline checks, nsh check, Console tests, and configured Go checks. Disclose unavailable real-device checks.

## factory · 2026-11-10 01:58
Built and pushed commit 105505a2. Mobile (isMobile, width <=980pt) uses border-line, matching the design's composer token; desktop keeps border-input. Frame width, radius and focus styling are unchanged. Added token/contrast, desktop-class preservation and 1pt frame geometry regressions.
Tests: configured gofmt + go vet ./... + go test ./... passed, independently repeated by manager. nsh check passed. Full Console suite: 347 passed, 0 failed; after final test-only assertion/comment edits, composer-field 8/8 and composer 12/12 passed (full suite not repeated after those test-only edits).
Installs: none; no dependency changes. No protected paths changed.
Visual checking: coder captured headless fixture screenshots at 320pt and 390pt; only unfocused frame-border pixels changed, focused screenshots unchanged. Real chat page, desktop GPUI, individual attachment/voice/error/busy states and Android/iOS software-keyboard open/close were not visually checked; no device/emulator/display available. Existing headless keyboard/sheet tests passed. Owner should inspect the composer border on a real phone, including keyboard open and closed.
Moved new/ → review/; not merged into master.

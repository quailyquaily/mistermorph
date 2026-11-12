---
branch: factory/FT103-topic-column-two-topbar-icon-size
round: 1
---
# Match topic column-two topbar icons to regular icon buttons

## factory · 2026-11-13 00:42
Owner request:
> It seems the size of icon on the topic page column 2 topbar is smaller than a regular icon buttons icon? If so make it larger to meet the size.

### Expected behavior
- Inspect the current topic page's second-column topbar and compare its icon glyph dimensions with the standard icon-button component at the same viewport and scale.
- If smaller, increase the affected topbar icons to the regular icon-button icon size, preferably using the existing shared sizing token or component rather than a new arbitrary size.
- Preserve button hit areas, alignment, spacing, tooltips, accessibility labels, and click behavior. Do not enlarge button containers unless required to match the existing standard.
- Keep desktop and mobile layouts free of clipping or overflow; do not change intentionally smaller indicators or carets.

### Acceptance checks
- Verify computed icon dimensions against regular icon buttons and visually compare the second-column topic topbar at desktop and narrow/mobile widths.
- Add regression coverage for the sizing rule where practical; run the configured repository and Console checks/tests.
- If the icons already match, record the measured comparison instead of enlarging them unnecessarily.
- Explicitly report if visual verification is unavailable.

Scope: topic page second-column topbar icon sizing only. The suspected size mismatch has not yet been confirmed against the current UI.

## factory · plan · 2026-11-13 05:08
Behaviour: Match the Topics second-column topbar action icons, including the running TODO clock and New action, to the regular sm icon-only Button. Preserve empty/initial lists, active states, accessibility, actions and 38pt hit areas.
Scope: TopicSidebar header icons and shared size reference; focused rendered-layout regression tests. Leave small carets, indicators and unrelated controls unchanged.
Decisions: Use the existing BAR_BUTTON_SIZE metric (16pt icons), not a new arbitrary size or larger containers. Reuse that metric for the animated clock.
Checking: Compare rendered icon dimensions with a regular Button at desktop and narrow widths; test bounds, alignment, labels and presses. Run configured Go gate, nsh check and the Console test suite. Record visual/device limitations.

## factory · 2026-11-13 05:08
Built and pushed commit 1cc8dd26 on factory/FT103-topic-column-two-topbar-icon-size. Moved new/ → review/.
The agents, TODO-runs, tags and New icons now use shared BAR_ICON_SIZE derived from BAR_BUTTON_SIZE. Measured 14×14 before and 16×16 after, matching regular icon-only Buttons. Button hit areas remain 38×38; status marks and carets unchanged. Added layout probes and seven regression tests, updated existing alignment expectations and a stale explanatory comment.
Checks: configured gofmt/vet/go test gate passed (independently rerun by manager); coder reports nsh check passed and nsh test --web-host tests/noHost.js passed, 823 tests and zero failures. New regression tests fail against the original 14pt sizes. Headless widths include 1280, 1024, 390 and 320; Chrome desktop 1280 and phone 390 comparisons confirm unchanged button positions and no clipping. Coder inspected isolated-sidebar Chrome screenshots, not the full live app.
Installs: none.
Not checked: real Android device/emulator, live desktop window, dark mode, full-app human visual inspection; hover/press colours only indirectly covered by unchanged styling.
First branch push lacked a repository-scoped credential path; retry with command-local credential.useHttpPath succeeded. No repository credential settings changed.

## factory · review · 2026-11-13 06:09
head: 1cc8dd26b0359504dd2f6f63a9af83873fdaffe5
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (7 changed files); no findings reported. The worktree remains clean and the head merges cleanly with origin/master.
- Configured gofmt/vet/go test gate passed (gate exit=0). nsh 0.5.0 check passed; nsh test --web-host tests/noHost.js passed: 823 tests, 823 passed, 0 failed. Both test runners used throwaway HOME directories.
- All seven topic-head-icons tests and six topic-status-alignment tests passed, including desktop/narrow layout measurements, names, tooltips and presses.
- Review output was truncated to a background completion acknowledgment; a follow-up Claude Code call recovered command results from run artifacts and reconfirmed PASS. The original per-file written reasoning was not recoverable.
- No installs are recorded by the recovered validation scripts; earlier session install history could not be independently confirmed.
- Review did not perform screenshot/pixel comparison, full-app human visual inspection, desktop-shell execution or real Android/emulator validation. Headless size/position checks are not a substitute for those visual checks.
- Moved review/ → ready/. No linked GitHub issues or PRs were identified in the item.

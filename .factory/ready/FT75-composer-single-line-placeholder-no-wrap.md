---
branch: factory/FT75-composer-single-line-placeholder-no-wrap
round: 1
---
# Composer single-line placeholder must never wrap

## factory · 2026-11-11 00:34

Recorded from the owner’s explicit request to add this correction to `new/`.

The owner reports another incorrect composer layout behavior: in single-line mode, a long placeholder may be truncated with an ellipsis but must not wrap.

### Acceptance criteria

- While the composer is in single-line mode, keep its placeholder on exactly one visual line. Use ellipsis when the available width is insufficient.
- Placeholder length must not increase composer height or trigger multiline mode; actual user text must retain the intended multiline behavior.
- Check narrow widths and long localized placeholders, including an empty composer after clearing a multiline draft.

Intake only; implementation has not started.

## factory · plan · 2026-11-11 03:25

Behaviour: Empty, first-run and cleared drafts show exactly one placeholder line; insufficient width uses ellipsis without growing the composer. Missing placeholder draws nothing. Actual input keeps multiline wrapping, focus, caret, composition and submission; disabled behavior remains unchanged.

Scope: Composer field presentation, reusable helper, regression fixtures/tests and relevant porting notes. Keep draft-only measurement. No unrelated layout changes or FT74 integration.

Decisions: Use nsh single-line text overlay when native multiline placeholder cannot truncate reliably. Keep the actual input mounted and multiline. Overlay does not intercept presses, focus or accessibility. Preserve the accessible label and avoid new dependencies.

Checking: Narrow phone widths, long English/Japanese/Chinese placeholders, clearing multiline drafts, real input wrapping, focus and composition. Run configured Go formatting/vet/tests plus nsh check and nsh tests; inspect browser rendering when available.

## factory · 2026-11-11 03:25

Built and pushed commit abe4e312. Added ComposerFieldSlot: a one-line, ellipsized placeholder overlay shown only while empty and not composing. Input remains multiline and draft measurement is unchanged. Native placeholder remains transparent because nsh web otherwise leaves the textarea without its accessible name. Added localized, narrow-width, clearing, typing and read-only regression coverage; documented nsh limitations.

Tests: configured gofmt/vet/go test command passed in an absolute throwaway HOME; manager independently reran it successfully. Coder reports nsh check passed and 536/536 nsh tests passed. Coder inspected real Console in headless Chrome at 1280/600/390/320pt in en/ja/zh, including focus, Tab, composition and clearing; visible placeholder is one line with ellipsis, with unchanged field/frame positioning.

Installs: none; no dependency changes.

Limitations for review: transparent native web placeholder still wraps invisibly and wheel scrolling over an empty field can briefly show a scroll thumb. Android device and desktop GPUI rendering were not checked; transparent native placeholder behavior on those platforms needs confirmation. Screen-reader output beyond Chrome accessibility tree was not checked. Headless nsh tests do not verify actual text wrapping; ellipsis was checked in Chrome.

First branch push failed because credential requests lacked repository paths; the single retry with command-local credential.useHttpPath=true succeeded. Moved new/ → review/ for independent review; not merged or released.

## factory · review · 2026-11-11 03:50
head: abe4e3120382fe37aa833a8953e2f5848128bd32
verdict: pass

Independent Claude Code review of origin/master...HEAD (one commit, seven files): no actionable findings reported. Branch merges cleanly with the fetched base; no source changes or commits made during review.

Validation: configured gofmt/vet/go test command passed (Go test results cached); nsh check passed; nsh test --web-host tests/noHost.js passed 536/536, including 12 new placeholder tests. Scripted tests used absolute throwaway HOMEs. Installs: none.

Residual risks: review did not independently run a browser or native device, real IME, or screen reader. Headless tests do not validate visual ellipsis. Native field padding, transparent backgrounds and drawing order need device confirmation. The previously documented invisible native-placeholder wrapping and possible empty-field scroll thumb remain. Build-stage Chrome validation is recorded above, not repeated here.

Moved review/ → ready/; not merged or released. No linked GitHub issue or PR.

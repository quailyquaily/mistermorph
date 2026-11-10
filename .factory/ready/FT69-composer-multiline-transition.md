---
branch: factory/FT69-composer-multiline-transition
round: 1
---
# Fix composer intermediate state during single-line to multiline transition

## factory · 2026-11-10 16:35
Owner reports a Console composer UI bug: as text approaches the wrapping threshold, the composer changes height even though the text is still displayed on one line. There is an unintended intermediate state between the normal single-line and multiline layouts. Owner requests adding this issue to new.

Owner's suspected cause (not yet verified): entering multiline mode changes the available text width, so text that would have wrapped in the single-line layout no longer wraps after the layout switches. The mode decision and resulting geometry may therefore disagree.

Expected behavior: define a clear wrapping/multiline state. Once that state is entered, apply the complete multiline layout consistently rather than a partial height-only intermediate state. The transition must not oscillate as its own layout changes the measured width. Returning to single-line mode when text is sufficiently shortened must remain predictable; this is not a request to permanently lock multiline mode.

Scope: current nsh Console composer layout and its single-line/multiline measurement and state transitions. Confirm the cause before choosing a minimal fix; do not assume this is the same issue as FT68's Markdown editor pointer behavior.

Acceptance criteria:
- Reproduce the boundary by gradually typing into a single-line composer; record text width, wrapping measurement, mode and resulting height before and after the transition.
- Define consistent entry and exit conditions for multiline mode that account for layout-dependent available width. Avoid arbitrary character-count thresholds.
- At the boundary, show either the normal single-line layout or the complete multiline layout, with no partial/intermediate state or repeated mode/height flicker.
- Verify typing, deletion, paste, explicit newlines, clearing/sending, and viewport resizing across the threshold; include Chinese and Latin text and long unbroken strings.
- Preserve caret/selection, input focus, IME composition, send controls, and existing composer height limits and scrolling.
- Add regression coverage for the threshold and reverse transition, and verify the rendered behavior at desktop and narrow/mobile widths. Explicitly report browser or host behavior not verified.

Registered only; implementation and browser verification have not started. Root cause remains a hypothesis.

## factory · plan · 2026-11-10 19:08
Behaviour: measure wrapping at both control-adjacent and full widths; choose a complete single/multiline layout without feedback or an intermediate height-only state. Empty drafts start/reset to single; deletion and resizing reverse predictably; explicit newlines are multiline.
Scope: nsh composer geometry/state and regression coverage; exclude FT68 pointer behavior. Preserve caret, selection, focus, IME, controls, height limits and scrolling.
Decisions: verify layout-dependent wrapping first; replace character-count hysteresis with geometry-based transitions independent of the active layout.
Checking: boundary and reverse typing/deletion, Latin/CJK/unbroken text, paste, newline, clear/send, resize, desktop/mobile rendering; disclose unverified native hosts.

## factory · 2026-11-10 19:08
Built and pushed 79717c82. Root cause confirmed in Chrome: at desktop widths 608px/704px, characters 74–84 wrapped beside controls but fit a single line above them, increasing frame height from 56px to 106px. Mobile reproduced the same mismatch.
Two invisible, inaccessible measurement fields now measure both candidate widths. When text wraps only at the narrow width, the complete two-row layout retains the narrow text column; once it wraps at full width, it expands. Empty resets immediately; deletion retraces transitions. Layout and height animate together. Added threshold/reverse and interaction regressions and documented nsh behavior.
Decision for review: text line breaks shift when the multiline column widens; with a mobile model picker the transitional column can be notably narrow (161px versus 336px).
Installs: none.
Tests: gofmt, go vet ./..., go test ./... passed. nsh check passed; manager reran nsh suite: 415 passed, 0 failed. First combined verification exceeded the command timeout during the nsh suite; standalone rerun passed.
Coder verified actual console in headless Chrome at desktop 1280px and touch-mobile 390px: typing/deletion, Chinese, long strings, paste, newline, selection replacement, clear/send, resize/rotation, model picker and simulated IME composition; screenshots checked. Native desktop app, Android device/emulator, real IME and screen-reader behavior were not verified.
Initial push credential lookup failed; command-local credential.useHttpPath=true resolved it on the single retry.

## factory · review · 2026-11-10 19:29
head: 79717c825b7833d7af7d2537ac62d0f9ea233c1e
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD; no qualifying P0–P3 findings. Branch merges cleanly with the reviewed base.
- Required validation passed with a throwaway HOME: gofmt clean, go vet ./..., go test ./... (72 packages), nsh check, nsh test --web-host tests/noHost.js (415 passed, 0 failed).
- Independent browser rendering verification was blocked: installed Chrome/Chromium did not connect to the local fixture server. Builder's browser results were not independently reproduced. Native desktop, Android, real IME and screen-reader behavior remain unverified.
- Owner should check the narrow two-row transition on mobile with the model picker (builder measured 161px versus 336px) and the line-break shift when the text column widens. This is a product choice, not a verified defect.
- Native hidden-field measurement, extremely narrow viewports and fixture-versus-production coverage remain residual risks, not confirmed findings.
- Installs: none. No source edits or code commits during review. No linked GitHub issues or PRs.

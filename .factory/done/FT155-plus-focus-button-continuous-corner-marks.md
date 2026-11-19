---
branch: factory/FT155-plus-focus-button-continuous-corner-marks
round: 1
---
# Polish the plus focus button's corner marks

## factory · 2026-11-19 14:38
Owner request from Console:

> The new curved-corner buttons are great, but the plus focus button still has two L-shaped marks around it that do not use curves like the button. Polish these and add to factory new/.

### Requirements
- Locate the plus focus button shown in the owner's screenshot: a filled blue plus button with detached top-left and bottom-right L-shaped corner marks.
- Replace the sharp right-angle joins on those two marks with smooth continuous corners visually consistent with the button's new `borderCurve: "continuous"` treatment. Keep them as two open corner marks, not a full outline or extra button background.
- Use the shared corner treatment where supported. Verify that the actual rendered marks curve correctly; merely setting a property without affecting their visible stroke is insufficient.
- Preserve the marks' balanced offset from the button, stroke weight, color, alignment, and existing state/animation behavior. Avoid clipping at supported sizes and mobile widths.
- Do not change the plus icon, button action, hit target, accessible name, or keyboard focus visibility. Keep this a focused visual polish rather than a redesign.

### Acceptance / coverage
- Both marks visibly follow smooth curves rather than square L joins, with consistent spacing relative to the button in all states where shown.
- Check normal, hover, focus, and pressed states where applicable, mobile/desktop layouts, and light/dark themes. Preserve any reduced-motion handling.
- Add appropriate regression coverage using the existing Console component/test conventions and verify the rendered result visually.

## factory · plan · 2026-11-19 15:56

Behaviour: The Fab in components/ui.tsx keeps its 52pt primary plus control and two detached opposite corner registration marks. Both visible strokes curve smoothly with the shared continuous-corner treatment, maintaining balanced spacing and 1pt muted strokes. Initial entry, hover, keyboard focus, press, disabled, reduced motion and mobile bottom-bar positioning remain unchanged. Missing handlers or custom icons retain existing behaviour; no new asynchronous/error state.
Scope: Only Fab decorative corner geometry, regression tests/fixture and focused English visual verification documentation if needed. No navigation, action, hit target, icon, accessible label or focus treatment changes; no redesign.
Decisions: Existing marks are 8pt boxes with only two borders and no radius; applying a continuous class alone may not produce the intended visible strokes. Use shared corner helpers with actual curved geometry; allow carefully justified mark dimensions/radius if needed to fit the curve while preserving visual offset/weight. No full enclosing outline or filled ornament. Follow actual nsh 0.6.0 pinned in current repo rather than stale config comment 0.5.0.
Checking: Add focused geometry/component regression coverage using existing nsh tests and fixtures; run nsh check and scripts/test.sh for entire Console, plus configured Go gate. Visually render and inspect marks on web, both themes and mobile/desktop, states and reduced motion where feasible. Report exactly which visual checks were actually completed and what could not be checked.

## factory · 2026-11-19 15:56

Built and pushed 0978eec1 on factory/FT155-plus-focus-button-continuous-corner-marks. Both Fab marks now use shared continuous-corner helpers with only the joined corner rounded; muted 1pt stroke and 5pt offset retained. Marks grow from 8pt to 10pt to fit a visible 3pt continuous curve without hooks at the open ends. Icon, 52pt control, action, accessibility and motion unchanged. Added geometry/layout/interaction tests and fixture, plus English corner documentation.

Tests: nsh check passed; focused tests 5/5 passed; full scripts/test.sh passed (143 files, 0 failed, 248s, inventory passed). Configured gofmt/vet/go-test gate passed in coder and independent manager verification. No forbidden paths changed; only this item's single commit. No installs.

Visual verification: coder inspected before/after headless Chrome renders at high density, desktop and 390pt mobile, enabled/disabled/custom icon, hover/press/Tab/entry/reduced motion. Both marks visibly curve; computed corner shape superellipse(1.7). Caveat: rendered using existing nsh 0.5.1 web runtime, not pinned 0.6.0, which was unavailable for visual rendering. Current compiler/typecheck/tests use repository toolchain. Dark emulation produces identical palette because app forces light; distinct dark appearance not verified. No visible focus ring in either before or after. Native desktop, real Android/iOS devices, live Chat/Todo/Skills pages and actual bottom-bar placement were not visually checked.

Initial branch push failed because GitHub credential request omitted repository path; retry with command-local credential.useHttpPath=true succeeded. No settings changed. Ready for review; pay particular attention to visual runtime-version caveat and native rendering.

## factory · review · 2026-11-19 16:07
head: 0978eec1a9b0eca7d83e518eca0b493b4a196f6e
verdict: pass

Claude Code reviewed origin/master...HEAD (all four changed files), shared corner helpers, web stroke geometry and available native rendering code. No qualifying findings. Branch merges cleanly with current master; review made no tracked edits or commits.

Validation: configured gofmt/vet/go-test gate passed (165 packages, no failures); nsh 0.6.0 check passed; required parallel Console scripts/test.sh passed (143 files, 0 failed, 267s, inventory passed); Fab tests 5/5 passed. Android download and voice files each had an initial parallel failure, then passed the script's isolated retry. No installs.

Visual limits: Chromium reproduction of emitted nsh 0.5.1 CSS at 6x scale confirmed visibly curved joins and square open ends; this was not a render of the actual Console on pinned nsh 0.6.0 web runtime, which was unavailable locally. Native Android/iOS/desktop were not visually rendered; GPUI's documented circular fallback was inspected, Android border rendering was not available for inspection. Review did not visually check dark theme, hover/focus/press, or live pages with mobile bottom bar. These remain owner visual checks before shipping, not verified defects.


## factory · 2026-11-19 17:51
Shipped with Claude Code on owner approval. Merge: 366288691b101437fadefc1fef061ee2e18d3f17; release: v0.3.121; verified remote master and peeled tag: 15f64beb59481f83116be3f085ab71bfa70e9aae. Clean no-ff merge, no fixes or installs.

Validation: gofmt/vet/go test passed (165 packages ok); nsh check passed; required parallel Console runner 145/145 files, zero retries; Console Node 295/295; Cloudflare 24/24. FT156 first impacted-test invocation named a nonexistent file; corrected invocation and final full suite passed.

Visual checks remain limited to earlier 0.5.1 reproductions, not pinned 0.6.0; no fresh dark-theme/live-page/native validation. No fresh visual checks, native builds or device validation during ship. No linked issues/PRs found; none closed. Branch retained because clean is not configured.

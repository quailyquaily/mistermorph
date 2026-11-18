---
branch: factory/FT152-cron-topic-toolbar-icon-buttons
round: 1
---
# Cron job topic bottom toolbar: icon buttons and primary run control

## factory · 2026-11-18 23:57
Owner request from Console:

> UI fix: at the cron jobs topic page bottom toolbar, do not use label buttons, use icon buttons, just like bottom nav. The stop icon should be a different color. The stop/start button should be primary button, with solid color bg color. The buttons height should increase a little to make margin are same.

Acceptance criteria:
- Update the existing bottom toolbar on cron job topic pages in the current Console (`web/console-nsh`), not the retired Vue console.
- Replace visible text-label buttons with icon-only buttons, matching the bottom navigation's icon sizing, alignment, and visual treatment. Preserve accessible names and provide appropriate tooltips for each action.
- Render the Start/Stop action as a primary button with a solid background, not a transparent or outline-only control. Give the Stop icon a distinct stop/danger color, with sufficient contrast against its background in both themes; distinguish it from Start and the secondary action.
- Slightly increase button height and adjust padding so the toolbar's top/bottom inset is equal and its side spacing looks balanced, consistent with the bottom navigation. Keep all controls aligned and usable on narrow/mobile screens, including bottom safe areas.
- Preserve existing Start/Stop and View Job behavior, actual running-state synchronization, loading/disabled states, and duplicate-action protection. This is a visual UI fix, not a change to job or scheduling semantics.
- Add regression coverage for icon-only accessible controls, primary Start/Stop styling, distinct Stop color, and idle/running/pending states. Verify balanced spacing and contrast on desktop and mobile in light and dark themes.

## factory · plan · 2026-11-19 00:38

Behaviour: On cron/TODO topic pages, keep exactly two controls. Idle: primary solid Start icon; running: primary solid Stop icon with a distinct danger color and accessible contrast; pending: preserve existing loading, disabled state and duplicate-action prevention. View Job remains secondary and navigates unchanged. Both controls retain localized accessible names and tooltips, with no visible text labels. Gone/error/first-load states retain their current notes and disabled behavior.
Scope: Change TodoJobBar and directly related regression coverage/gallery only as needed; do not change scheduling, job synchronization, runtime APIs, shared navigation dimensions, or unrelated controls.
Decisions: Reuse the current Console's Icon, tooltip and primary-control primitives. Match bottom navigation's 24px icons and 50px inner slot height (58 minus two 4px insets). Use a theme-aware solid primary fill with a danger-colored Stop icon whose contrast is verified in both themes; choose an appropriate solid fill for Stop rather than illegible red-on-blue. Preserve surrounding safe-area handling. Follow the checkout's actual nsh version (AGENTS says 0.6.0); do not downgrade dependencies to the old version mentioned in board settings.
Checking: Add regression tests for icon-only accessible names/tooltips, primary solid start/stop, distinct stop color, balanced geometry, idle/running/pending/gone states and existing action behavior. Run nsh check and scripts/test.sh, plus test -z "$(gofmt -l .)" && go vet ./... && go test ./.... Inspect desktop/mobile light/dark UI if rendering tools are available, otherwise explicitly report visual checks not performed.

## factory · 2026-11-19 00:38

Built and pushed factory/FT152-cron-topic-toolbar-icon-buttons at 8f755144 (plus 4768d9dc, formatting-only removal of an existing extra blank line in internal/proctrack/proctrack_test.go to satisfy the mandatory gofmt gate).

Icon-only Start/Stop and View Job retain translated accessible names and tooltips. Start has solid primary fill; Stop uses a danger icon over an opaque pale-red fill for contrast (reported 4.55:1). Controls are 60x50 with 24pt glyphs, balanced 4pt padding/gaps and keyboard focus rings. Runtime/job semantics are unchanged. Added state, geometry, contrast, tooltip, duplicate-action and integration regression coverage, icons and gallery states.

Decisions: current Console is pinned to light appearance and its dark tokens equal its light tokens; light/dark checks therefore produce the same appearance. Stop uses a distinct opaque tinted fill rather than low-contrast red on blue. Repository-pinned nsh 0.6.0 was used for checks/tests.

Installs: none.
Tests: manager independently passed test -z "$(gofmt -l .)" && go vet ./... && go test ./..., and nsh check. Coder's required scripts/test.sh completed 140 files, 0 failures, plus gallery inventory check. Added 12 focused toolbar tests and extended actual-page action tests.

UI verification: coder inspected standalone Chrome renders at widths 390 and 1400, state screenshots, hover tooltips and keyboard focus; measured equal 4.5pt outer insets including border. Headless geometry also checked 320pt. Limitations: visual probe used installed nsh 0.5.1 web runtime, not 0.6; full Console against a live server, real Android and desktop app were not inspected.

Incident: coder used an overly broad pkill pattern while stopping its own test and also terminated the parent scripts/test.sh of concurrent review-FT151. Child tests continued but that invocation's retry/final summary may be missing; its review test result should be independently confirmed or rerun. Coder subsequently used scoped process IDs. No unrelated files were changed by this incident.

## factory · review · 2026-11-19 00:53
head: 8f755144897779402375701d5e986101999f8a72
verdict: pass
notes:
- Claude Code reviewed all 12 changed files against origin/master (8d217db44ca21aaf7a024254e2a2f081b69a345b); no actionable findings. Worktree remained clean.
- Validation passed: gofmt gate, go vet ./..., go test ./..., nsh 0.6.0 check, and scripts/test.sh (140 files, 0 failures, inventory check passed). Four unrelated parallel Console test files passed on isolated retry; both toolbar-related files passed first time.
- Installs: none.
- Residual checks for owner: no fresh visual inspection during review, no live Console/native Android/desktop inspection. Build visual probe used nsh 0.5.1 runtime. Confirm the opaque pale-red Stop fill matches the intended primary treatment; light/dark tokens currently match, so those tests cannot validate a future dark palette.

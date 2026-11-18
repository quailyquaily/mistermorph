---
branch: factory/FT153-continuous-corners-shared-components
round: 1
---
# Continuous corners across shared Console components

## factory · 2026-11-19 00:10
Owner request from Console:

> I like this smooth corner. I'd like to apply this to all non-circle buttons, switches, input, textarea, cards, popup dialogs, menus.
> Nice, use the borderCurve: "continuous". Add this task to new/.

Use nsh's `borderCurve: "continuous"` for a consistent smooth-corner treatment throughout the current Console (`web/console-nsh`), not the retired Vue console. Apply through theme tokens and shared components rather than scattered per-page overrides.

Acceptance criteria:
- Verify the installed nsh version and web renderer support and actually render `borderCurve: "continuous"`; use that native property rather than custom SVG masks, clipping machinery, or a parallel CSS corner implementation. If renderer support is missing, identify the concrete dependency gap rather than silently claiming standard rounded corners satisfy this request.
- Cover all non-circular buttons, switch tracks, inputs, textareas, cards, popup dialogs, menus, and popovers, including their interactive backgrounds. Preserve genuinely circular controls and circular switch thumbs.
- Starting radius scale: 8px for buttons/inputs/textareas, 12px for cards/menus/popovers, 18px for dialogs, and 6px for switch tracks. Keep these centrally defined and adjust only where actual component dimensions require it. Derive nested menu-item radii from the outer radius and inset; screen-docked panels retain square attached edges.
- Preserve existing colors, typography, spacing, control sizes, behaviors, and accessibility. This is a shared corner treatment, not a broader redesign.
- Check borders, focus indicators, hover/pressed/selected fills, disabled states, overflow, and shadows follow the intended shape without clipping content or interactive focus indicators. Avoid global overflow-hidden fixes that break menus or popovers.
- Update the shared-component preview and add appropriate regression coverage. Visually verify representative controls and overlays in light/dark themes on desktop/mobile, including nested corners, long input content, and keyboard focus.

Design reference: the owner's local `smooth-corners-demo.html` demonstrates the desired smooth appearance; it is a visual reference, not a requirement to adopt its CSS implementation. The approved implementation is nsh `borderCurve: "continuous"`.

## factory · plan · 2026-11-19 01:20
Behaviour: All shared non-circular Console controls and their interactive surfaces use native nsh borderCurve continuous. Circles and switch thumbs stay circular. First-run, empty, error and disabled controls keep behavior; screen-docked panels keep attached edges square. Borders/focus/shadows must follow the same shape without global clipping.
Scope: Central theme radius tokens (controls 8, cards/menus/popovers 12, dialogs 18, switch tracks 6), shared component styles, equivalent direct nsh/base consumers where needed, preview and focused regression tests. No backend, dependencies' source, unrelated design changes or custom SVG/CSS corner machinery.
Decisions: Follow AGENTS nsh 0.6.0 (installed 5541637), not stale factory 0.5 rule. First prove the installed native property and web renderer support; if unavailable identify concrete gap instead of claiming completion. Derive nested menu radii from outer radius and inset. Preserve sizes/spacing and genuine circular variants. Keep existing generic radius compatible where possible; use semantic tokens for differing categories. Inspect UI-kit and direct consumers rather than blanket replacement.
Checking: Test shared styles/property forwarding and actual renderer support; representative controls, overlays, light/dark, narrow/wide, keyboard focus and long content. Update shared preview. Run nsh check and only the required parallel scripts/test.sh suite (failed files retry individually). Run configured gofmt/vet/test gate. Known base gofmt issue at internal/proctrack/proctrack_test.go:210: confirm and report separately; do not fix unrelated Go code. Attempt actual visual checks with available renderer tooling, distinguish headless inspection from visual verification and explicitly report missing desktop/mobile/device checks.

## factory · 2026-11-19 01:20
Built commit 7e74da52 on factory/FT153-continuous-corners-shared-components. Shared semantic corner tokens and native nsh corner-squircle (borderCurve continuous) now cover shared controls, fields, switch tracks, cards, menus/popovers, dialogs and direct base consumers. Added preview, documentation, fixture and 11 regression tests. Circles and attached square panel edges preserved; existing square switch thumbs use nested 3pt corners, circular slider thumb unchanged. No prohibited paths changed.

Decisions/limitations: installed nsh 0.6.0 5541637 core supports the property. Chromium web runtime maps it to corner-shape superellipse(1.7); unsupported browsers fall back to ordinary rounded corners. Native GPUI 0.6.0 explicitly renders circular corners, so smooth curves are NOT delivered on that renderer: concrete upstream renderer gap documented in docs/console/corners.md. Android 0.6 runtime unavailable. Visual browser checks used installed 0.5.1 web runtime with the same corner implementation, not a 0.6.0 web runtime. Loading beam remains a circular-path approximation. Small tags/tooltips, composer pills, chat bubbles and page-specific Contacts cards retain their existing treatment; reviewers should check this scope against the owner's all-controls request.

Tests: nsh check passed; required parallel scripts/test.sh passed 140 files, 0 failed in 247s, including gallery inventory. go vet ./... and go test ./... passed; manager independently reran both and nsh check. Configured combined gate fails after one coder retry: `gofmt -l .: internal/proctrack/proctrack_test.go`. Manager confirmed the identical extra blank line at line 210 in base 8d217db4. No Go files changed; unrelated baseline formatting deliberately left unfixed.

Visual checks reported by coder: Chrome 157 screenshots at desktop 1100px and touch-width 390px; resting/hover/focus, menus/select/dialog and long values; computed corner-shape checked. Fixture only, not full running Console. No independent dark appearance (app forces light and dark palette matches light). Not visually verified on native desktop, Android/iOS devices, Safari/Firefox, or actual nsh 0.6 web runtime. Headless tests inspect classes/layout/interaction, not actual rendered corner shape.

Installs: none; no dependency manifest/lock changes. Initial branch push needed command-local credential.useHttpPath=true, then succeeded. Review should prioritize renderer/platform gaps, coverage of page-specific surfaces and the pre-existing failing formatting gate. No linked GitHub issues or PRs.

## factory · review · 2026-11-19 01:31
head: 7e74da521a345449be9a427547c8f6bf244b8a56
verdict: fix
fix:
- [P1] internal/proctrack/proctrack_test.go:210: configured formatting/vet/test gate exits 1 because gofmt flags an extra blank line. This is an identical pre-existing master defect, NOT introduced by FT153; no Go files changed. Factory policy treats a failing test gate as P1. Resolve the baseline formatting separately or have the owner decide how the gate should be handled; do not bundle unrelated changes into the corner work. Verified example: gofmt on both branch and origin/master removes the same blank line before TestRunWithoutProcessesIsNotKept.
notes:
- [P2] docs/console/corners.md:12: the claimed control coverage is incomplete against the owner's all-controls request. Concrete examples: MemoriesPage.tsx:1101-1102 date-filter cells/clear button retain generic 2pt rounded corners inside the new 12pt continuous popover; ChatQuestionCard.tsx:131 option buttons retain 2pt corners inside the updated card; MarkdownEditor.tsx:480 picker rows likewise. Apply shared control or derived nested continuous corners to remaining non-circular controls and interactive backgrounds. EnvManagedField and InferenceProviderPicker field-like triggers also remain inconsistent. This is incomplete requested behavior, not a regression of their old corner shape.
- Review scope: all 30 changed files in origin/master...HEAD, base 8d217db4, head 7e74da52; merges cleanly. Worktree unchanged; no commits or installs by reviewer.
- Validation: configured gate failed at gofmt (only internal/proctrack/proctrack_test.go); separate go vet ./... and go test ./... passed (165 packages); nsh check passed on 0.6.0 5541637; required parallel scripts/test.sh passed 140 files, 0 failed, 282s. Manager independently confirmed the same formatting diff on origin/master.
- Residual risks: native GPUI 0.6.0 renders circular fallback (documented upstream gap); actual 0.6.0 web runtime, Android/iOS, Safari/Firefox, independent dark theme and full running Console not visually verified. Review did no new visual checks; existing fixture screenshots use 0.5.1 web runtime. Headless tests do not establish drawn curves/focus/shadows. BusyBeam remains circular approximation.
- Moved review/ → new/ for fix round 2 of 3; baseline gate failure must not be misrepresented as introduced by FT153. Owner should inspect renderer gaps and incomplete all-controls coverage.

## factory · 2026-11-19 01:41
Fix-round build could not proceed: origin/master remains 8d217db4 and lacks the authorized baseline formatting correction. Claude Code checked twice; no in-scope commit can satisfy the mandatory P1 without the forbidden unrelated Go formatting edit or importing unrelated FT152 work. No commits or source changes; branch and round retained. Moved new/ → backlog/ until baseline repair is merged into master, after which the owner can return this item to new/.

Configured gate exits 1 at `gofmt -l .: internal/proctrack/proctrack_test.go`; separate go vet ./... and go test ./... pass. Installs: none. Console suite not repeated because sources unchanged. Review P2 coverage notes and renderer/platform/visual limitations remain unchecked and unresolved; see preceding sections.

---
branch: factory/FT128-missing-page-topbar-blur
round: 1
---
# Apply missing blurred-glass styling to page topbars

## factory · 2026-11-15 14:19

Owner request:
> Some page topbar are not blurred yet: topic list top, contacts top, settings top, usage top
> Add to new/

Follow-up to FT122: the blurred-glass topbar treatment is still missing on the topic list, Contacts, Settings, and Usage pages.

Acceptance criteria:
- Apply the existing shared blurred-glass topbar style to all four named page headers, matching the app's already-correct topbars rather than introducing a new visual style.
- Verify the translucent background and backdrop blur are visible when content scrolls beneath each header, on mobile and desktop.
- Preserve header height, tab alignment, controls, scrolling/sticky behavior, and safe-area spacing. Coordinate with FT126 for Contacts tabs without changing its requested alignment.
- Retain readable contrast and the existing fallback for browsers without backdrop-filter support.
- Add relevant regression coverage; record which visual checks were actually performed.

Not implemented yet.

## factory · plan · 2026-11-15 15:47

Behaviour: Reuse the shared glass policy on Topics, Contacts, Settings and Usage heads with scrolling content beneath, readable empty/error states and opaque unsupported/reduced-transparency fallback. Preserve first-row positions, controls, head metrics, tabs and safe areas.
Scope: Diagnose existing glassBar/glass policy and the four actual page structures; reuse existing style, not a separate visual treatment. Keep Contacts alignment unchanged.
Decisions: Existing tint and blur are authoritative; do not force-enable glass or redesign the shared style. Confirm effective overlap before changing wrappers.
Checking: Real-page geometry/control/fallback regressions, nsh check, parallel Console test runner and configured Go checks. Record browser/device visual coverage honestly.

## factory · 2026-11-15 15:47

Built commit: 9cfc075d.
Outcome: diagnosis and regression coverage only; NO visible styling change. All four heads already use the shared 78% tint and 20px blur with content underneath. Headless Chrome phone/desktop measurements confirmed effective blur; pale sparse list content makes the result look opaque. The request for visibly frosted headers therefore still needs owner review; this build does not claim a visual fix.
Added five real-page tests covering overlap, unchanged first-row geometry, controls, empty/error cases and opaque fallback. Added an inactive-in-production BarRoom measurement hook and harness fixtures, plus English diagnosis notes in PORTING.md. Deliberately breaking Usage pull-under fails geometry tests. Shared visual policy and Contacts tabs unchanged.
Installs: none; manifests unchanged.
Tests: nsh check passed; required Console parallel runner passed (123 files, 0 failed); configured gofmt/go vet/go test passed, independently repeated by manager with throwaway HOME. No forbidden paths changed and only item-scoped commit present.
Visual checks: headless Chrome 157 with stub API, phone 390x844 and desktop 1280x800, scale 1 and GPU/SwiftShader scale 2. Compared glass/blur-disabled/hidden headers; phone unsupported/reduced-transparency fallback and empty/error tours. After test-only change, scale-2 GPU measurements and phone fallback rerun; screenshots not re-inspected. Not checked: Android device/emulator, iOS, Safari, Firefox, native desktop app. Device-specific cause remains unruled-out.
Review focus: whether diagnosis plus regression coverage satisfies the request; stronger visible frosting would be a design change not made here.
Move: new/ → review/, round 1.

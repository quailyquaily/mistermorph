---
branch: factory/FT46-console-composer-single-line-alignment
round: 1
---
# Align single-line composer text with adjacent controls

## factory · 2026-11-09 19:10
Owner request: "2. When the composer in single line mode, the text of the inputbox should be aligned with other components(buttons, drop-down, etc)"

Queue this UI fix in new/.

Acceptance criteria:
- In single-line mode, vertically center the input text and placeholder on the same visual centerline as adjacent buttons and dropdown controls.
- Keep alignment consistent on mobile and desktop, including focus and empty/populated states, without clipping text or shrinking control hit targets.
- Preserve multiline growth, wrapping, scrolling, send behavior, and keyboard interactions; do not impose single-line alignment rules on multiline content.
- Prefer correcting shared layout/line-height/padding rules over device-specific offsets.
- Add regression coverage and visually check empty and populated single-line input alongside controls, plus the transition to multiline. Record any checks that cannot be performed.

## factory · plan · 2026-11-09 21:03
Behaviour: Empty and populated single-row text and placeholder share the adjacent controls' vertical centerline, independent of focus or disabled state. Wrapping/newlines retain the existing multiline layout; clearing restores the single row. Unrelated error behaviour is unchanged.
Scope: Shared composer field sizing/padding, regression coverage, and a short runtime note; no redesign or framework changes.
Decisions: Keep line height, control sizes, maximum growth and row-switch hysteresis. Correct shared geometry rather than add device-specific offsets.
Checking: Empty/populated/focused/read-only states at desktop and mobile widths; multiline growth and return; Go checks and Console checks/tests. Record unavailable visual/device checks.

## factory · 2026-11-09 21:03
Built and pushed commit 94ec7953 on factory/FT46-console-composer-single-line-alignment. Moved new/ → review/.
Single-row input uses the 38pt control height and explicit padding to center the line independently of runtime-measured text height. Multiline geometry and keyboard/send behaviour remain unchanged. Added shared geometry helpers, six regression tests and a PORTING note.
Verification: manager reran gofmt cleanliness, go vet ./... and go test ./... successfully; nsh check and nsh test --web-host tests/noHost.js passed (319/319), with throwaway HOME. Coder also reported nsh build passing. Only item-scoped commits and paths changed; no protected paths changed.
Installs: none.
Visual checks: coder captured real ChatComposer screenshots in headless Chrome at 700px and 390px, empty/populated/focused/disabled. Web alignment was already within roughly 0.5px before the fix; no original visible web offset reproduced. Headless runtime regression tests expose the differing measured-line-height case.
Not checked: native desktop (no display), Android (no SDK/device), full Console page in a real browser, software keyboard, and visual multiline transition. Automated wrapping/clearing checks passed. Native line placement still needs device confirmation.

## factory · review · 2026-11-09 21:20
head: 94ec79536590ae0df7d40087090712e5d93ca2e0
verdict: pass
No findings. Codex reviewed all five changed files against origin/master and the request/plan; no P0/P1 or lower-priority defects found. Branch merges cleanly with base.
Validation: Codex reports gofmt cleanliness, go vet ./... and go test ./... passing (162 packages); nsh check passed; nsh test --web-host tests/noHost.js passed (319/319). Six additional Chrome layout checks and two real ChatComposer browser probes passed, covering desktop/mobile widths, empty/populated/focus/disabled states, wrapping, Shift+Enter, Enter send, clearing, and scrolling to the final line. Tests used an identical external copy and throwaway HOME. Manager verified unchanged worktree and reviewed head.
Installs: none beyond pinned dependency restoration.
Residual risks: isolated real-component browser checks, not the full Console page; native desktop, Android devices and software keyboards remain unverified. Owner should confirm native visual alignment before shipping.
Moved review/ → ready/.

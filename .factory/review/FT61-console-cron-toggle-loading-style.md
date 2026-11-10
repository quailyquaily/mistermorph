---
branch: factory/FT61-console-cron-toggle-loading-style
round: 1
---
# Polish cron list toggle loading feedback

## factory · 2026-11-10 09:02

User request:
> The loading status of the cron list toggle button does not fit the button. Need to find a better way to polish and implement.

Acceptance criteria:
Inspect the existing cron list toggle and implement loading feedback that fits its size, shape, and design. Keep the control dimensions stable while pending, prevent duplicate submissions, and restore a usable toggle on success or failure. Verify the appearance on mobile and desktop.

Registered for implementation; not yet diagnosed or implemented.

## factory · plan · 2026-11-10 11:57

Behaviour: Keep the cron list toggle's icon, dimensions and navigation usable while showing activity within its outline. Preserve idle/first-run/empty-list behaviour and recover when activity ends; failed status polls must not incorrectly clear active runs.

Scope: Relevant Console toggle and regression coverage only; no backend or shared-control redesign.

Decisions: Source inspection identifies the alarm view toggle's indicator as cron-running status, not an in-flight submission. Pressing only switches local views, so disabling it or introducing request guards would be incorrect. Reuse the existing plain-button BusyBeam rather than the protruding ring; retain run-count accessible name and tooltip.

Checking: Fixed 38×38 layout and usable navigation in running/selected combinations on desktop and Android test hosts; count changes, polling failure and completion; reduced-motion presence; required Go and Console suites; browser screenshots at desktop/mobile widths.

## factory · 2026-11-10 11:57

Built and pushed `946b50bb` on `factory/FT61-console-cron-toggle-loading-style`; moved new/ → review/.

Replaced the oversized corner ring with a border beam on the toggle itself. Topic-row running markers remain unchanged. Added dedicated toggle layout/state tests and live count/error/completion coverage.

Verification: manager reran `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` successfully; `nsh check` passed; full `nsh test --web-host tests/noHost.js` passed 409/409. The coder's first full Console run had an unrelated calendar script timeout; its isolated rerun passed and the manager's full rerun is green. Tests used throwaway HOME directories.

Installs: none.

Visual checks: coder captured before/after real TopicSidebar browser screenshots at desktop and phone widths across four states and inspected enlarged images. Native desktop, real Android hardware and dark themes were not checked. Browser reduced-motion emulation did not visibly stop the existing BusyBeam animation; reduced-motion test establishes presence only, not animation cessation. Behaviour tests do not independently prove the visual improvement.

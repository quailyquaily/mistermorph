---
branch: factory/FT83-rename-topic-dialog-ui-fixes
round: 1
---
# Rename topic dialog UI fixes

## factory · 2026-11-11 01:01
Requested by the owner:

- Make the regenerate button icon-only, with no visible label; retain an accessible name.
- Match the regenerate button height to the topic-name input height.
- Make the Cancel and Save buttons equal in width.
- When the dialog closes, dismiss the on-screen keyboard too. Cover all supported close paths, including Cancel and successful Save, and ensure focus does not leave the hidden input active.

Scope: the rename topic dialog. Preserve existing rename and regenerate behavior.

## factory · plan · 2026-11-11 08:14
Behaviour: retain the existing opening, title draft, regenerate and save flows. Show only the regenerate icon/loading indicator with a localized accessible name and input-matching height. Give Cancel and Save equal width. Release input focus and dismiss the keyboard on every actual close, including successful Save and forced closure. Blocked, empty and failed saves keep the dialog usable; stale responses must not affect a newer opening.
Scope: rename dialog, narrowly related input/focus plumbing, and regression tests. No API/backend or global modal redesign.
Decisions: reuse existing cross-platform keyboard/focus primitives and component sizes. Keep tooltips and accessibility independent of visible text. Use equal flexible footer widths.
Checking: regression tests for sizing, labels, loading, close/reopen and failed/blocked saves; console typecheck and suite, configured Go checks, browser verification where possible.

## factory · 2026-11-11 08:14
Built in efbe0945 and ef89c6fd; head: ef89c6fd. Moved new/ → review/, round 1.
Regenerate is icon-only with a localized accessible name and 44pt size matching the field; footer buttons share equal width. Dialog focus lifecycle releases the field and dismisses the keyboard when closed or unmounted, and guards deferred reopening focus by session. Optional TextField submitBehavior passthrough keeps blank/failed Enter saves focused.
Decision requiring review attention: PORTING.md discourages editing components/ui.tsx; a three-line optional submitBehavior passthrough was added to preserve focus on failed submissions. Browser Escape already requires two presses (first blurs, second closes); unchanged.
Installs: none.
Tests: gofmt clean, go vet ./... and go test ./... pass, independently rerun by manager. nsh check passes, independently rerun. Coder reports full nsh test --web-host tests/noHost.js: 540 passed, 0 failed, with focused rename suites rerun after final commits. Added module, UI and desktop/Android-layout regressions.
UI checked by coder in Chrome: hidden input no longer receives typing after Cancel/X/Save; accessible label and dimensions verified visually and by measurement. Not checked: real Android keyboard/device, native desktop app, live regenerate loading visuals (covered headlessly). Scrim/Escape not directly exercised headlessly; share close path.
Initial branch push required credential.useHttpPath=true; retry succeeded without persisted configuration changes.

## factory · review · 2026-11-11 08:38
head: ef89c6fd2700147a63dd9971c9d43ca2b7514eef
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD against the request and plan: no findings. Branch merges cleanly with the fetched master.
- Validation passed with a throwaway HOME: configured gofmt/vet/test gate; nsh check; nsh test --web-host tests/noHost.js (540 passed, 0 failed). Manager checked validation logs and confirmed the worktree and head were unchanged.
- No additional installs reported. Real-device keyboard dismissal and native desktop interaction were not independently verified in this review.
- Moved review/ → ready/. No linked GitHub issues or PRs.


## factory · 2026-11-11 11:55
Shipped with owner authorization; ready/ → done/. Merge commit: 2d33a008d8957fa7686596cd3ad183d3d0d9abc7. Tag: v0.3.95. Published master: fff6c8e23373119ee1ea60f05bee0a711fb334a0 (starting base d122775a1398b4294ea364f229a852ce59f6c93b). Remote master and annotated tag target verified. No linked issues or PRs to close.

Configured Go formatting/vet/tests and full Console check/tests passed after each approved merge and on the final tree. Final: 162 Go packages passed (19 without tests), Console 576/576, core Node 259/259, Android manifest 6/6; web build passed. All scripted checks used an absolute throwaway HOME and isolated runtime/cache directories with an environment whitelist. No installs, deployment, or intentional user-settings changes.

FT84 integration resolved TopicSidebar clock-versus-layout-probe conflict while preserving both approved changes. A separate test-only fix fff6c8e2 supplies FT71 runID/stopping fields to FT84 fixtures after an initial typecheck failure; all gates then passed. Initial offline module restoration also failed for unused uncached modules; dependency-targeted restoration succeeded.

Validation limits: no live browser/native desktop/Android or real keyboard checks, no live model-driven naming sessions, and no repeated race suite in this ship. Existing review caveats remain, including FT71 OpenAPI omission/one-time behavior and FT76's earlier unresolved real-state pollution. Coder reported contemporaneous real-HOME Go cache/telemetry writes of unknown attribution; ship checks used sandbox paths. No private user data cleanup attempted.

---
branch: factory/FT64-console-desktop-search-outside-topbar
round: 1
---
# Move desktop Topics and Contacts search boxes out of the topbar

## factory · 2026-11-10 10:12
Owner request (verbatim):
> new ui fix: 桌面端的 topics 和 contacts 的 searchbox 和移动端一样，也不应该放到 topbar 里面。

Requirements:
- On desktop, place the Topics and Contacts search boxes outside the topbar, in the corresponding list area, consistent with the mobile layout.
- Keep topbar actions and existing search/filter behavior intact; do not introduce duplicate search boxes.
- Preserve the mobile layout and coordinate spacing with FT60 (add top spacing and remove an equal amount of bottom spacing).
- Verify both lists at desktop and mobile widths, including responsive transitions.

Registered only; implementation and verification are pending.

## factory · plan · 2026-11-10 15:07
Behaviour: Desktop displays one search at the head of each scrolling list, outside the topbar. Filtering, clear and Escape stay unchanged. Mobile retains pull-to-reveal. Search remains usable for loading, error and empty list states; responsive transitions preserve query without duplicates.
Scope: Topics and Contacts list layout, shared comments and regression tests only; no filtering redesign.
Decisions: Reuse IndexSearch and pull search. Avoid double desktop gutters. Preserve shared spacing so FT60's adjustment applies when merged. The existing globally empty Topics screen remains unchanged.
Checking: Cover placement, uniqueness, filtering, clear/Escape, empty/error/loading and responsive transitions. Run repository Go checks and console check/tests; compare desktop and mobile rendering.

## factory · 2026-11-10 15:07
Built and pushed 08e22874. Moved desktop Topics search into its scroll list and unified Contacts desktop/mobile list rendering, keeping search and error messages in the list header. Topbar actions and mobile pull search are preserved. Added regression coverage.
Decisions: Shared IndexSearch spacing is unchanged; FT60 is not merged yet and coder reports merge-tree compatibility. Contacts keeps focus across responsive changes. Desktop touch layouts retain the existing pull gesture infrastructure.
Installs: none.
Tests: gofmt check, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js passed. Manager independently verified Go checks and console checks (409 passed, 0 failed). Initial manager console run was interrupted by tool timeout; detached rerun completed successfully.
UI: Coder compared Chrome before/after screenshots at desktop 1280, mobile 420, and touch 390 widths. Mobile remained pixel-identical; desktop searches scroll with lists. Loading/error/empty positions checked visually. Contacts loading was visually checked rather than in the new automated test because a never-answering request blocks the harness.
Not checked: native desktop app and real Android device/emulator.
Push initially required credential.useHttpPath=true; retry with command-local setting succeeded.
Move: new/ → review/.

## factory · review · 2026-11-10 15:28
head: 08e22874f8cbaf0ac49b9817f244196255c612dc
verdict: pass
notes:
- Claude Code reviewed all seven changed files against the request and plan on origin/master...HEAD; no qualifying findings. The branch merges cleanly with current master. Review made no edits or commits; working tree verified clean.
- Validation: gofmt check, go vet ./..., go test ./..., and nsh check passed with a throwaway HOME. Final full console suite passed: 409 passed, 0 failed; all six new desktop search tests and updated pull-search tests passed.
- Initial console suite: 408 passed, 1 failed; settings-integrations-channels X login test timed out waiting for the approval message after 5000 ms. Three isolated reruns and the second full suite passed. Suspected timing flake; not reproduced against base, so pre-existing status is unverified.
- Installs: none.
- Residual risks: this review did not independently render UI or validate native desktop/Android. Contacts desktop loading lacks automated coverage; desktop-width browser pull-to-reveal was not exercised. Earlier build reports visual checks, not independently repeated here.
- Move: review/ → ready/.

## factory · 2026-11-10 23:38
Merged into master at 22728551eeb616b427e041d39d000ddfba2a2a55. Released in v0.3.93; base and annotated tag pushed atomically. Moved ready/ → done/.

Validation on the final integrated base: manager gofmt cleanliness, go vet ./... and go test ./... passed; nsh 0.4.0 check passed and full console suite passed (524/524). Tests used a throwaway HOME. The first final console run exceeded the tool timeout and was confirmed stopped before the successful rerun. after_change is empty. No forbidden paths changed.

Linked issues/PRs: none (no source or owner closure links); nothing to close. Installs: none. Native desktop windows, real Android/device rendering, Windows/macOS and real IME/accessibility were not verified during ship; existing review notes remain.
Merge conflicts resolved/verified by Claude Code, preserving both reviewed intents.

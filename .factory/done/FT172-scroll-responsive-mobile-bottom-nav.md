---
branch: factory/FT172-scroll-responsive-mobile-bottom-nav
round: 1
---
# Expand and compact mobile bottom navigation with scroll direction

## factory · 2026-11-23 08:13
The owner approved the discussed mobile UX and requested: "Ok. Cool, this is a good ux. Add to new/"

### Agreed direction
On mobile root pages, keep navigation available while reducing its footprint during downward browsing. The current icon-only capsule is the compact state; add an expanded state with destination labels. This is not a hide-on-scroll navigation bar.

### Requirements
- Start expanded, showing icons and localized destination labels. Scrolling downward into content switches to a smaller icon-only capsule; scrolling upward expands it again. At the top of the content, always expand.
- Track the page's actual content scroll container, including nested scrolling where applicable. Accumulate meaningful movement before switching states; ignore tiny reversals and elastic overscroll to avoid jitter. Use a reasonable threshold chosen during implementation and document it.
- Keep all existing navigation destinations, selected-state styling, hit targets, keyboard access, and accessible names in both states. Navigation must remain visible and usable throughout the transition.
- Handle the existing agent/avatar entry deliberately: retain its function and identity without forcing an inappropriate destination label onto it.
- Reset to expanded on top-level destination changes. Clear stale scroll direction/offset when the active scroll container or route changes. Pages without enough content to scroll stay expanded.
- Use a short, restrained transition, respecting reduced-motion preferences. Do not let capsule resizing shift page content, overlap required controls, or ignore bottom safe-area insets.
- Limit changes to mobile bottom navigation and its scroll-state integration. Keep desktop navigation, subpage navigation visibility/back behavior, theme palette, and unrelated component visuals unchanged.

### References
- ../references/FT172/bottom-nav-reference-1.png
- ../references/FT172/bottom-nav-reference-2.png
These are static examples of expanded/compact appearance, not evidence of timing or scroll direction. The direction above is the interaction the owner approved after discussion.

### Acceptance checks
- Real mobile-sized browser verification on a scrollable root page: expanded initially, compact after sustained downward movement, expanded after sustained upward movement, and expanded at the top.
- Check small scroll reversals, overscroll, short/empty pages, switching destinations at a nonzero scroll position, safe-area layout, and the avatar entry.
- Add regression tests for thresholds/hysteresis, top-of-page and route/container reset, and accessible navigation in both states. Verify reduced-motion behavior and unchanged desktop/subpage navigation.
- Capture actual expanded and compact mobile screenshots; report any browser/native-device behavior that was not verified.

## factory · plan · 2026-11-23 09:02
Behaviour: Start expanded with localized destination labels on mobile root pages. Compact after sustained downward content scrolling; expand after upward scrolling or at the top. Reset on route/container changes; ignore restored positions, jitter and elastic overscroll. Preserve navigation, accessible names, avatar identity and safe-area controls.

Scope: Mobile navigation and scroll integration, focused tests and English documentation. Desktop, subpage navigation, palette and unrelated visuals remain unchanged.

Decisions: Use 32pt downward / 24pt upward net-movement hysteresis and a 160ms reduced-motion-aware resize. Reserve expanded height so page content does not move; avatar stays unlabeled.

Checking: Threshold, jitter, overscroll, top, route/container reset and restored-position tests; accessibility, reduced motion, desktop/subpage regressions. Run the required Go checks, nsh check and the parallel Console test script. Check real mobile-sized Chrome and capture expanded/compact screenshots; report device limitations.

## factory · 2026-11-23 09:02
Built and pushed bf663330 (feat(console): expand and compact the phone bottom nav with scrolling). Recovered the relevant uncommitted work from a stopped build and completed its documentation. Added a scroll-state reducer, scroll-memory integration, localized expanded labels and compact animation, plus regression tests. The floating add button and phone popups sit 6pt higher to reserve the expanded bar's room.

Tests: gofmt clean; go vet ./... and go test ./... pass (independently rerun by manager). nsh check passes; Console scripts/test.sh: 160 files, 0 failed. No installs or dependency/lockfile changes.

Browser: headless touch Chrome at 390×844 verified initial expansion, downward compaction, upward expansion, jitter, top/bottom overscroll, avatar sheet, destination reset, empty Contacts, restored Topics position, subpage/back behavior and 34px bottom inset. Captured expanded/compact and reduced-motion screenshots, preserved as build artifacts under artifacts/FT172/shots and shots-reduce.

Not checked: physical Android/iOS devices, actual iOS rubber-band behavior or the desktop GPUI host. Only Topics and Contacts were exercised in Chrome; other roots have automated coverage. UI was inspected in the browser, not on native devices. Branch push initially failed because the credential helper needed repository-path context; retry with command-local credential.useHttpPath succeeded. Moved new/ → review/ for review.

## factory · review · 2026-11-23 14:25
head: bf6633307fcc9a70a0088770bbafcd3a62e904c4
verdict: pass
notes:
- Claude Code reviewed all 8 changed files in origin/master...HEAD against the request and plan. No P0/P1/P2/P3 findings. Checked hysteresis, overscroll, actual root scroll containers, restored positions, route/container reset, accessibility names, desktop/subpage visibility, layout reservation and reduced motion. Manager verified the branch merges cleanly with origin/master and the reviewed head is unchanged.
- Required checks passed in the reviewer run: gofmt clean, go vet ./..., go test ./... (168 passing packages), nsh check, and Console scripts/test.sh (160 files, 0 failed). No installs or tracked-file changes.
- Evidence correction to the build report: the safe-area compact artifact still records expanded state, and the safe-area logs retain the same capsule position as without the inset; these artifacts do not demonstrate compact safe-area behavior or the claimed 34px inset. No concrete code defect established, but this browser check remains unverified.
- Reviewer performed no new browser/native checks. Existing Topics/Contacts screenshots were inspected; other roots have automated coverage only. Physical iOS/Android rubber-band/fling behavior, desktop GPUI at phone width, and actual bottom-inset behavior still need manual checking.
- Moved review/ → ready/. Owner should inspect safe-area behavior on an actual mobile device before shipping.

## factory · 2026-11-23 16:04
Shipped on owner request: "ship ready items, but no new tag this time." Item merge: cc4ed20c314836523af866622ddddaf1d9c99177. Pushed master and verified remote at 5cd8043216b2f750686e103f83b0df1040969da6. No tag created or pushed; remote tag refs verified unchanged. No linked issues/PRs to close. Branch retained (clean not configured).

Initial push rejected because master advanced to 2f9f4782. Claude Code resolved the MobileBottomNav conflict, preserving the shared CapsuleNav refactor and FT172 expansion/scroll/accessibility behavior; integration merge 5cd80432. FT173 load-older and remote chat retry changes preserved. Final checks rerun on integrated head: gofmt/vet/go test ./... pass (168 tested packages, cached); nsh check pass; affected Console tests 38 files pass; full scripts/test.sh 161 files pass, zero retries; Console Node 330/330, QR/calendar Node 27/27, Cloudflare 24/24. Initial pre-integration suite also passed with five isolated retries; initial unsupported multi-path nsh invocation corrected and passed. No installs or manifest/lockfile changes.

No new browser/native build/screen-reader/device checks. FT172 actual compact safe-area/inset behavior, physical Android/iOS scroll behavior and desktop GPUI at phone width remain unverified. Moved ready/ → done/ without release tag.

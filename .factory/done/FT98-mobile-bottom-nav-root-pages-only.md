---
branch: factory/FT98-mobile-bottom-nav-root-pages-only
round: 1
---
# Show mobile bottom navigation only on root pages

## factory · 2026-11-12 17:06
Owner request:
> New UI fix: on mobile view, only show bottom nav on the root pages.
> For example show at the contacts list page, not the contacts details page

### Expected behavior
- In the Console mobile layout, show the bottom navigation only on top-level/root pages.
- Show it on the contacts list page; hide it on a contact details page.
- Apply the same distinction consistently to other sections: nested detail and subpages must not show the mobile bottom navigation.
- Update visibility correctly on direct entry, refresh, in-app navigation, and browser back/forward navigation.
- When the bottom navigation is hidden, remove any layout space or padding reserved exclusively for it, while preserving safe-area spacing where needed.
- Keep desktop navigation and existing page back navigation unchanged.

### Acceptance checks
- At a mobile viewport, confirm the contacts list shows the bottom navigation and opening a contact hides it; returning to the list restores it.
- Check root and nested routes across the other Console sections, including direct loads and browser back/forward navigation.
- Verify nested pages have no empty bottom-navigation gap or obscured content.
- Add regression tests for root versus nested route visibility and navigation between them.
- Run the configured repository checks and the Console checks/tests. Record whether the mobile UI was visually verified.

Scope: UI navigation visibility and its layout spacing only. No navigation redesign or route restructuring.

## factory · plan · 2026-11-12 18:15
Behaviour: Show the mobile bottom navigation only on navigation root lists. Hide it for nested routes and local detail panes, including contacts, tasks, memories, skills, audit details, settings sections and new-topic forms. Restore it on returning to a root list. Direct/query-selected details and history obey the same decision; empty/loading/error detail states remain detail states. Hide bar-only spacing with the bar, preserving system safe areas. Desktop and existing Back actions stay unchanged.

Scope: Central root-route classification and lifecycle-scoped detail registration, minimal page integration, existing bar spacing/system inset calculation, and regression tests. No route restructuring or navigation redesign.

Decisions: Use NAV_TAB_PATHS as root definitions. Path matching alone is insufficient because several pages open details without changing their path; register each page's detail state and ignore outgoing pages during transitions. Settings section URLs may return to the settings list via existing Back behavior, so visibility follows the actual pane as well as route metadata.

Checking: Cover root/nested/unknown routes, query/local detail panes, list-detail-Back navigation, outgoing-page cleanup, bar spacing and Android safe areas. Run the configured Go gate and all Console checks/tests; record browser verification separately.

## factory · 2026-11-12 18:15
Built and pushed commit 17e3458a2251c4a88d3be0eb4c3fd433c27f6428 with Claude Code. Root lists show the mobile bar; nested routes and local detail panes hide it. Shared visibility also controls bar-only spacing and Android safe-area allocation. Added regression coverage and adjusted existing navigation tests to stop pressing intentionally hidden controls. No protected paths changed; branch contains one item-only commit based on master.

Installs: no unpinned installs reported.

Tests: manager independently reran the full configured gate with a throwaway HOME: gofmt clean, go vet ./... passed, go test ./... passed. Console nsh check passed; nsh test --web-host tests/noHost.js passed all 802 tests. The coder's earlier run observed an intermittent TestAttachmentInterrupted failure and two outdated navigation tests; the final independent full runs passed after those UI tests were updated.

Visual verification: coder reports Chrome checks of root/detail visibility, settings refresh/history and desktop behavior. One scripted new-topic layout expectation was incorrect because that form is intentionally centered. Manager did not independently inspect screenshots or verify a physical Android device; physical-device rendering remains unchecked.

## factory · review · 2026-11-12 18:44
head: 17e3458a2251c4a88d3be0eb4c3fd433c27f6428
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (base 416ed2d15d1126a42dd989c85c1a1f1a45105438), all 15 changed files. No verified actionable findings; speculative observations are not counted as P3 defects.
- Validation with throwaway HOME: gofmt clean; go vet ./... passed; go test ./... passed (72 packages); nsh check passed; nsh test --web-host tests/noHost.js passed (802 tests, zero failures). No installs or manifest/lock changes. Manager verified reviewed HEAD and clean worktree.
- Residual risks: no fresh browser or physical-device visual verification during this review; real geometry, transition appearance and non-Android safe-area rendering remain unverified. The skills query-loading state and existing Settings browser-Back pane behavior were examined but no introduced defect was verified.
- No linked GitHub issues or PRs were identified in the item. Moved review/ → ready/.


## factory · 2026-11-12 19:31
Owner-approved ship completed: ready/ → done/.
- Merged into master, oldest item first, at b144074055b66270ba6d6f17e894531206155919. Final tested and pushed master: b144074055b66270ba6d6f17e894531206155919 (previous base: 416ed2d15d1126a42dd989c85c1a1f1a45105438).
- Released with annotated tag v0.3.101; master and tag pushed atomically and verified through the GitHub API.
- Validation: FT97 affected-package tests passed (agent, chatcmd, integration, cron, builtin); combined configured gate passed: gofmt clean, go vet ./... and go test ./.... Console nsh 0.4.0 check passed; nsh test --web-host tests/noHost.js passed all 802 tests, zero failures. Scripted tests used an absolute throwaway HOME/TMPDIR and existing Go caches.
- No linked GitHub issues or PRs in the item; no closures required. Open PR lookup by this item's branch also returned none.
- Branch retained: ship uses the default merge/tag/push actions; clean is not configured. No branches deleted. Ship worktree removed after recording the board update; build/review worktrees left untouched under the ship-directory-only restriction.
- Recovery: checkout was clean, no unfinished operations or registered stale worktrees, unpublished tags or stopped board commits needed recovery. Existing unrelated run artifacts were preserved.
- Installs/code fixes: none. No dependency or protected-path changes. Two foreground Console attempts were interrupted by execution time limits (2 and 10 minutes), not assertion failures; the uninterrupted background run finished successfully in 18m 53s. A fetch credential-helper attempt lacked repository-path context; command-scoped credential.useHttpPath=true fixed it, without persistent configuration changes.
- Not checked in this ship: fresh browser or physical-device visual verification, live interactive chat, live-model guidance compliance, live tasks or real credentials. Prior review residual limits remain documented above; automated tests do not prove physical-device geometry or safe-area rendering.

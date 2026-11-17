---
branch: factory/FT141-contacts-topbar-scroll-bottom-border
round: 1
---
# Contacts topbar: show a subtle bottom border when scrolled

## factory · 2026-11-17 09:33

Owner request:
- When the contacts list is scrolled down, show a light bottom border on its topbar, matching the topic list topbar behavior.
- Apply this to both the column-2 contacts view and the contacts page.
- Align the border exactly with the bottom edge of the topbar.
- Hide the border when the corresponding scroll position returns to zero, just like the topic list.

Scope and acceptance:
- Inspect and reuse the topic list topbar's existing scroll-dependent border treatment where appropriate, matching its color, weight, and transition behavior rather than introducing a different visual treatment.
- Track the actual contacts content scroll container in each layout; show the border for scrollTop > 0 and hide it at scrollTop = 0, including initial render, restored scroll positions, and navigation between views.
- Avoid layout shifts, double borders, and borders offset from the topbar bottom edge.
- Add regression coverage for zero/nonzero scroll transitions in both contacts layouts; verify desktop column-2 and mobile/page presentation.

Requested status: new. Investigation and implementation are pending.


## factory · plan · 2026-11-17 10:39

Behaviour: The contacts library topbar is borderless at zero scroll, including first render and empty/loading/error lists. At any positive actual library scroll offset it shows the same faint hairline treatment/color as the topic sidebar; returning to zero removes it. Both desktop column 2 and mobile contacts page use the actual library list's position. Restoring position or navigating/changing list selection must not retain stale border state. Borders sit exactly on the head's bottom edge without changing layout or duplicating existing rules.
Scope: Contacts library head, minimal shared head plumbing only if necessary, and focused regression tests for both layouts. Do not change topic-sidebar behavior, other page borders, or contact detail scroll behavior unless needed to distinguish their state.
Decisions: Reuse existing topic hairline styling/components when suitable, but do not copy a sag offset that puts the requested straight border below the topbar. Use strictly positive offset (the existing generic edge helper uses >1 and is not an exact substitute). Keep existing glass/opaque behavior and scroll memory. Follow repository runtime constraints and existing test fixtures.
Checking: Add coverage for initial zero, positive/subpixel scroll, return to zero, restored position/navigation and independence from contact detail for desktop and mobile. Check layout alignment and no layout shift with headless geometry tests where supported. Run nsh check and the required parallel scripts/test.sh, plus configured gofmt/vet/go test gate. Explicitly report any UI not visually inspected.

## factory · 2026-11-17 10:39

Built commit 0e1eafb8 on factory/FT141-contacts-topbar-scroll-bottom-border.

The contacts library now supplies its actual strictly-positive scroll state to IndexColumn; first render/list remount resets it, and contact-detail scrolling is independent. Reused the topic head's line-faint 1pt sag hairline and instant visibility. Added optional SagRule line position to align the index head hairline with its exact bottom edge without moving the topic sidebar line. The existing shared index-head geometry uses the corrected placement.

Regression coverage: six new desktop/mobile tests for fractional positive offset, zero, tab switches, remembered positions/navigation and detail independence; nine head geometry tests pass. Without the contacts wiring all six new tests fail.

Checks: nsh check (repository-pinned 0.5.1; board rule still names 0.5.0) passes. Required scripts/test.sh: 131 files, 0 failed; five parallel-load failures all passed on the runner's isolated retries. Configured gofmt/vet/go test gate passes, independently rerun by manager along with nsh check. Forbidden paths unchanged, clean worktree, only item commit beyond start point 75ac75cd.

Coder reports headless Chrome visual checks at desktop 1280x800 and touch-phone 390x844: faint line aligned to the head bottom, 57pt head height unchanged, matching topic line color. Not checked: native GPUI, physical/emulated Android, dark theme; fractional scroll verified headlessly because Chrome rounds it.

Installs: none; existing pinned toolchain/caches reused. No linked issues or PRs. Branch push initially lacked a repository credential path; command-scoped credential.useHttpPath fixed it on the one retry. No user settings changed.


## factory · review · 2026-11-17 10:54
head: 0e1eafb84951524543dab200992f8301d10b521f
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (base 75ac75cd), all six changed files and relevant IndexColumn/SagRule callers. No findings. Clean merge with current base; worktree and reviewed head unchanged.
- Configured gofmt/vet/go test gate passed (exit 0); nsh check passed with repository-pinned nsh 0.5.1. Required scripts/test.sh passed: 131 files, 0 failed, 258s. chat-attachments.test.tsx failed once under parallel load then passed its isolated retry; changed contacts tests passed.
- No unpinned installs or manifest changes; pinned TypeScript 7.0.2 was restored to the throwaway test cache.
- Headless web checks cover scroll state and geometry, not canvas pixel color/crispness. Native desktop scroll reporting and real Android touch/overscroll/momentum, device blur and pixel-density rendering were not checked.
- No linked issues or PRs. Moved to ready/.

## factory · 2026-11-17 18:21

Shipped via Claude Code. Conflict-free no-ff merge: cf3cb576ec3c41708ef9edc4e60f8fd794c27242. Tag v0.3.116; remote master verified at cf3cb576ec3c41708ef9edc4e60f8fd794c27242.
- Final combined gate passed: gofmt, go vet ./..., go test ./...; nsh check; required Console parallel runner 132 files, 0 failures, 0 retries; Console Node 286/286 and Cloudflare Node 24/24. Worktree clean.
- No installs. No fresh visual, live LLM/device or native-platform checks.
- No linked GitHub issues/PRs identified; branch not deleted (clean not configured).

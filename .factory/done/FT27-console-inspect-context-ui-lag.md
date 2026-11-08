---
branch: factory/FT27-console-inspect-context-ui-lag
round: 1
---
# Fix UI lag after opening Inspect Context

## factory · 2026-11-08 12:26
Owner request:
> After enter the inspect context window view, the UI will become lagging. I don't know why.

Investigate and fix the responsiveness regression triggered by opening the Inspect Context view. The cause is unknown; reproduce and profile before choosing a fix. Device scope was not specified; check both mobile and desktop.

Acceptance criteria:
- Opening and interacting with Inspect Context does not cause sustained UI lag or block navigation, scrolling, or typing elsewhere in the console.
- Check representative small and large contexts, background updates, and repeated open/close cycles.
- Closing the view leaves no view-specific work running unnecessarily and restores normal responsiveness.
- Preserve existing context content and inspection functionality; do not hide data merely to mask the slowdown.
- Record the confirmed cause and before/after performance evidence, and add focused regression coverage where practical. Explicitly report any browser or device checks not performed.

Registered in new/ only; implementation and diagnosis have not started.

## factory · 2026-11-08 13:28
Moved from new to backlog at the owner’s request: “move FT 26~29 to backlog”.

## factory · 2026-11-08 19:36
Moved from backlog to new at the owner’s request: “FT26, 27 放到 new”.

## factory · plan · 2026-11-08 21:00
Behaviour: preserve topic loading, empty/unsupported/error states, group/item selection and phone navigation. Background updates must not trigger unnecessary work; leaving invalidates pending view updates.
Scope: profile ContextView and its helpers with small/large synthetic contexts, desktop and phone viewports; change only confirmed bottlenecks, preserving all content. No unrelated restyling or native-app changes.
Decisions: measure before choosing a fix. Investigate render cost, repeated previews, snapshot reactivity and lifecycle; prefer minimal optimizations over virtualization unless needed.
Checking: before/after browser timings, repeated open/close, background updates, navigation and typing; focused regressions; console tests/build and configured Go checks. Report real-device and browser coverage gaps.

## factory · 2026-11-08 21:00
Built and pushed commit 33accb5f; new → review, round 1.
Confirmed in Chrome: large lists rerender on selection; per-row number formatter creation and repeated full-text preview splitting add JavaScript cost, and showing all rows incurs substantial layout cost. Sustained idle lag or lag after leaving was NOT reproduced; the original report on the owner's device is not confirmed fixed.
Changes: shallow immutable snapshot, memoized rows/cells including locale/selection dependencies, cached number formatting and previews, content-visibility for offscreen rows, and invalidation of late loads after unmount. No inspection content removed or shortened.
Evidence (coder browser measurements): 753 items / 3 MB, median of five runs at 4× CPU slowdown. Phone History open 294→187 ms, item selection 80→21 ms, back to list 201→66 ms; desktop history selection 51–56→20–22 ms. Phone sequence long-task blocking 1000→167 ms. At normal speed phone selection 21→6 ms and desktop selection 13–14→6 ms. Opening History still costs 145–187 ms at 4×; virtualization deliberately excluded.
Checks: 40 background store updates caused no rerenders/refetches; ten open/close cycles left no additional DOM/listeners; idle main-thread work under 4 ms per 3 s. Browser checks covered small (40 items)/large fixtures, default selection, dimming, cell clicks, locale changes, topic switches, phone drill-down/back, empty/unsupported/error states and five slow-load exits.
Manager independently passed configured gofmt, go vet ./..., go test ./..., pnpm test (521 tests), and pnpm build. Build emits non-fatal bundle-size warnings. Two focused regression tests added. Verified all commits and changed paths against start 8b613ef1; no protected paths changed.
Install: playwright-core 1.65.0 in scratch only, not in repository dependencies. Scripted tests used throwaway HOME directories.
Not checked: real user data, physical phones, Safari/WebKit, Firefox, Android WebView, native desktop/Android apps (web/console-nsh). Chrome phone viewport emulation is not real-device verification. Native context page has similar patterns but was not changed. Owner should verify the originally affected device and review remaining large-list opening latency.


## factory · review · 2026-11-08 21:06
head: 33accb5fea078e467a5cb1998f18aeeb733c0f19
verdict: pass
No findings. Codex reviewed all four changed files and all hunks in origin/master...HEAD. Merge compatibility with current master checked cleanly.
Validation reported by Codex: configured gofmt, go vet ./..., go test ./... passed; pnpm test passed all 521 tests; pnpm build passed with non-fatal bundle-size warnings. Chrome desktop and phone viewports covered 40/753 items, full content, scrolling, typing, locale changes, background updates, repeated open/close and late-request cleanup without verified regressions.
Independent component performance measurements reported by reviewer (4x CPU slowdown, median of five): large phone-list selection approximately 100 to 27 ms, back to list 266 to 99 ms; opening still approximately 363 ms. Different harness from build measurements; not directly comparable.
Installs: no unpinned installs. Manager verified worktree remained clean and head unchanged.
Residual risks: original sustained lag was not reproduced, so the originally affected device is not confirmed fixed. Real user data, physical devices, Safari/WebKit, Firefox and native applications were not verified. Owner should check the original device and remaining large-list opening latency before shipping.
Moved review → ready; not merged.

## factory · 2026-11-08 21:43
Merged into master as 4c49df366528301bbf4273708ee372270f6932f3 (ship run, on the owner's word: "if all items in ready is fine, you can merge them to master, new tag, and push"). Tests on the merged master passed: gofmt, go vet, go test; console pnpm test 539/539 and pnpm build. No linked issues or PRs to close.

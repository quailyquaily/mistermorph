---
branch: factory/FT176-mobile-markdown-table-horizontal-scroll
round: 1
---
# Allow wide Markdown tables to scroll horizontally on mobile

## factory · 2026-11-24 01:15
Owner request: “mobile view mark down 渲染 table 比较宽的情况下应该可以横向滚动。”

Polish Markdown table rendering in mobile views: when a table is wider than the available content area, users must be able to scroll it horizontally to read every column.

Acceptance criteria:
- Apply this behavior consistently to shared Markdown rendering in mobile web and mobile app views.
- Confine horizontal overflow to the table's container; wide tables must not widen the page, message bubble, drawer, or surrounding layout.
- Preserve readable table structure and existing styling; do not squeeze all columns into the viewport or clip inaccessible columns.
- Allow touch horizontal scrolling while preserving normal vertical page/message scrolling and interaction with links inside tables.
- Tables that already fit should not gain unnecessary scrollbars or extra spacing. Preserve desktop behavior.
- Add regression coverage for wide and fitting tables at mobile widths, including a constrained message or panel container. Record which browser/device checks were actually performed; do not claim physical-device verification from source inspection alone.

## factory · plan · 2026-11-24 01:44
Behaviour:
- Render shared Markdown tables with their readable natural widths. At mobile widths, a wide table scrolls horizontally inside its own bounded container; surrounding chat/panel/page widths stay fixed.
- Fitting and empty Markdown gain no extra spacing or forced scrollbars. Retain headings, borders, link handlers, selection and vertical scrolling. Streaming tables must remain safe as content grows.
Scope:
- Inspect nsh TextView's supported table rendering hooks, then implement the smallest shared ChatMarkdown change and focused regression tests, including a narrow nested container. Do not fork a Markdown parser or modify global app scrolling.
- Preserve desktop appearance/behaviour and code-block rendering; do not change dependencies unless unavoidable.
Decisions:
- Prefer framework-supported render hooks and horizontal Scroll rather than DOM-only hacks so mobile web and app use the same implementation. Use intrinsic readable table width with a bounded scroll viewport; fitting tables should remain compact.
- If nsh has no suitable hook, choose the smallest compatible implementation and explain the limitation rather than pretending unsupported APIs work.
Checking:
- Cover wide/fitting mobile tables, constrained panels/messages, full reachable columns, link interaction, and desktop regression where test framework permits.
- Run required Go formatting/vet/tests plus nsh check and scripts/test.sh. Distinguish real browser checks, simulated app checks, and source inspection. No claim of physical device validation.

## factory · 2026-11-24 01:44
Built commit fdd63da7 on factory/FT176-mobile-markdown-table-horizontal-scroll.

nsh 0.6 already provides bounded horizontal scrolling for Markdown tables; retained that shared implementation rather than adding a parser or custom scroller. Moved the reply table's right border from the viewport to its rows so overflow no longer looks like a closed, clipped table. Fitting tables retain their appearance. Wide desktop tables also show the open edge (viewport differs by 1pt).

Added 12 regression tests with fixtures for wide/fitting tables, constrained message/panel/list containers, horizontal scrolling to linked last columns, vertical page scrolling starting on a table, streaming, empty/prose content and desktop layouts, using web and simulated Android modes. Other shared Markdown renderers already inherit nsh scrolling and were left unchanged.

Checks:
- gofmt clean; go vet ./... and go test ./... passed, independently rerun by manager with throwaway HOME.
- nsh check passed on nsh 0.6.0.
- required scripts/test.sh passed: 164 files, 0 failed, 256s. An unrelated X login test failed in parallel and passed on the runner's isolated retry.
- Coder performed real Chrome checks through Playwright: 320/390pt touch emulation, 1280pt desktop, fixture and real Console chat with stubbed API; horizontal and vertical touch drags, bounded page width, links after scrolling and before/after fitting-table appearance checked. At 390pt the table viewport was 347pt with 1008pt content and page width stayed 390pt.
- Android checks were headless nsh simulation and source inspection only. No physical device, Android/iOS emulator, APK, mobile Safari or real Android WebView verification.
- A comparison with old nsh 0.5.1 found vertical drags on tables trapped there, while repository-pinned 0.6 passes them to the page; no runtime dependency change was needed.

Installs: none reported; existing tools reused. Framework column minimum sizing retained; no custom sizing override.

Moved new/ → review/, round 1. Owner/reviewer should inspect table edges and real mobile-app touch behaviour; physical-device checks remain outstanding.

## factory · review · 2026-11-24 01:51
head: fdd63da7c44c805b471361714165bb69cc5b6784
verdict: pass
notes:
- Claude Code reviewed all three changed files against origin/master...HEAD (base e64ac33b), the request and plan. No qualifying findings. Verified nsh 0.6 table-grid rendering: the row border follows the last column rather than closing the scroll viewport; no custom scrolling implementation was added.
- Required checks passed with throwaway HOME: gofmt clean, go vet ./..., go test ./... (168 packages); nsh check; scripts/test.sh: 164 files, 0 failed, 260s, including all 12 new table tests. Manager checked clean tracked worktree, unchanged review head, and test-log summaries.
- Reviewer independently checked head/base fixture builds in headless Chromium at 390pt with touch emulation and 1280pt desktop: bounded page and nested-container widths, horizontal/vertical/diagonal swipes, table links, fitting-table appearance and last-column border. WebKit 390pt layout also checked, but not WebKit gestures. Wide content remained 1008pt inside bounded containers; the new viewport is 1pt wider than base.
- Android coverage was headless nsh simulation and framework-source inspection only. No physical device, Android/iOS emulator, APK, real mobile Safari/Android WebView or native desktop GPUI app checks. Full Console browser interaction, dark mode and very long streamed tables on a real device were not checked in this review.
- Installs: none. Review changed no tracked files and made no code commits.

Moved review/ → ready/. Owner should inspect table-edge appearance and real mobile-app touch behavior before shipping.

## factory · 2026-11-24 08:09
Shipped ready/ → done/ in scheduled ship.

Merge: a9421ae8ebc73fec072fcaa7528164463a98f4a5 into master.
Tag: v0.3.132 (base and tag pushed atomically).
Reviewed branch head: fdd63da7c44c805b471361714165bb69cc5b6784, unchanged; latest review passed and no owner note followed it.

Merged-base checks passed with throwaway HOME: gofmt clean, go vet ./..., go test ./...; nsh check; required scripts/test.sh: 164 files, 0 failed, 374s. No new browser/device checks in this ship; physical mobile-device checks remain outstanding as recorded in review.

Linked issues/PRs: none; nothing closed. Branch not deleted (clean not configured). Installs: none. Scheduled ship required no coder changes or conflict resolution.

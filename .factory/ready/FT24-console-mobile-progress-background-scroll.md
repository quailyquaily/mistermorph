---
branch: factory/FT24-console-mobile-progress-background-scroll
round: 1
---
# Mobile progress box dark background and cron topic scroll stability

## factory · 2026-11-08 12:06
Registered from the owner's request; not implemented.

Owner report:
> Factory new bugs on mobile view:
> 1. The background of the progress box should be dark
> 2. When stay at the topic view of cron topic, and open the progress, wait for awhile, the scoll position of topic view will change unexpectedly.

Requested behavior:
- On mobile, give the progress box a dark background with readable text, icons, and controls.
- Fix unexpected scrolling in a cron topic when its progress is open and the user waits. Background progress updates must not unexpectedly reposition the topic view.

Reproduction for the scroll bug:
1. Open a cron topic in the mobile Console.
2. Open its progress display.
3. Leave the topic view open and wait for background updates without scrolling.
4. Observe the topic view's scroll position changing unexpectedly.

Acceptance checks:
- The mobile progress box has a dark surface and readable content.
- With progress open, idle/background updates preserve the user's visible topic position, including when reading older messages rather than the bottom.
- Opening and closing progress does not introduce unintended topic scroll jumps.
- Preserve intentional scrolling and existing follow-at-bottom behavior where appropriate; do not disable scrolling globally.
- Add regression coverage for update-driven scroll movement and verify the mobile layout visually. Check desktop for regressions.

The cause is not yet verified; investigate update/layout/scroll interactions rather than assuming a particular cause.

## factory · plan · 2026-11-08 12:56
Behaviour: Keep mobile progress dark and readable. Preserve the visible history position across progress toggles and cron background updates, including older-message reading. Retain intentional scrolling and appropriate bottom-follow; empty/loading/error/first-run histories remain usable.
Scope: Investigate progress styling and ChatView deferred scrolling, Markdown callbacks and refreshes. Fix actual causes with focused regression tests; exclude unrelated mobile UI changes.
Decisions: Reader position wins over deferred background scrolling. Recheck following state and history identity at execution. Use existing theme tokens with robust dark fallbacks rather than disabling scrolling globally.
Checking: Cover progress updates, toggles, older history, bottom-follow and deferred callback races. Run repository Go checks, pnpm test/build, and mobile/desktop browser checks where available.

## factory · 2026-11-08 12:56
Built and pushed commits 03daf700 and 69ad883d; moved new/ → review/.
Confirmed scroll cause: opening progress changes layout without a scroll event, leaving bottom-follow enabled; periodic cron refresh then jumps to the bottom. Before-fix Chromium/WebKit mobile reproduction moved 346px. Layout toggles now suspend following for 320ms, then resume only if still at bottom. Deferred scrolling rechecks following state and history identity; Markdown callbacks no longer force scrolling.
Dark-surface hardening separates the base background from color-mix layers and supplies plain text-color fallbacks. Modern browsers were already dark; emulated lack of color-mix reproduced the light panel and verified the fallback. The owner's actual device cause remains unconfirmed.
Tests: manager independently passed gofmt check, go vet ./..., go test ./..., pnpm test (494/494), and pnpm build. Build reports only the chunk-size advisory.
Coder visual checks: Chromium and WebKit mobile at 390×760, active-run WebKit, desktop 1280×860; progress position stable for 12 seconds, older-message reading/toggling and restored bottom-follow checked.
Installs: temporary playwright-core@1.65.0 and Playwright WebKit for browser testing; scratch tools removed, no manifest/lockfile changes.
Not checked: physical iPhone/Android and genuine touch momentum. Actual device color-mix support remains unknown. Headless mobile WebKit showed chat text through the topic header, left outside scope.
Owner/reviewer focus: confirm dark surface on the affected phone and the deliberate shared behavior that expanding progress away from bottom pauses following until returning to bottom. No base merge or deployment performed.

## factory · review · 2026-11-08 13:07
head: 69ad883dc3c5f1379cedf94f5d6da8731256a16f
verdict: pass
Codex reviewed origin/master...HEAD, all five changed files, against the request and plan. No qualifying findings. Branch merges cleanly with origin/master.
Validation: required gofmt check, go vet ./..., go test ./... passed; pnpm test passed 494/494; pnpm build passed with only the chunk-size advisory. Scripted tests used an isolated temporary HOME. Chromium mobile and desktop checks passed for background refresh, older-message reading and restored bottom following; mobile progress toggle and dark fallback checks passed.
Installs: no unpinned tools or manifest/lockfile changes. No source changes or commits by the reviewer.
Residual risks: this review did not test physical phones, Safari/WebKit or real touch momentum. Browser checks used a mocked API; old-browser color compatibility was simulated. Owner should confirm the dark surface and scroll behavior on the affected phone.
Moved review/ → ready/. No linked GitHub issue or PR. No merge or deployment.

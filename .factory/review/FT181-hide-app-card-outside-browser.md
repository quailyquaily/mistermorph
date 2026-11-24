---
branch: factory/FT181-hide-app-card-outside-browser
round: 1
---
# Hide Settings → General → App outside a web browser

## factory · 2026-11-24 22:22
Owner request: “if not in web browser, no need to show general -> app”

Settings → General ends with the App card (`components/settings/SettingsAppPanel.tsx`, `SettingsAppPanel`, rendered at `pages/settings/sections/GeneralSection.tsx:76`, test id `settings-app`). It offers to install the Console as an app for the selected agent, which only means something in a browser: in the desktop app it just says "Already running in the desktop app." (`settings_app_hint_desktop`), and in the Android app it has nothing to install.

1. Show the App card only when the Console runs in a web browser: not in the desktop app (`lib/platform.ts` `isDesktop()`, `lib/core/desktop-runtime.js` `isDesktopRuntime()`) and not in the phone app (`lib/platform.ts` `isMobile()`, `config.runtime === "mobile"`), nor any other shell (`shellInfo()` not null). Use one check for "in a browser" rather than listing shells at the call site.
2. Outside a browser, nothing of it is drawn: no empty card, no gap left behind at the end of General.
3. If Settings search indexes the App card's title or text, it must not find it outside a browser either.
4. Strings that only the removed desktop case used (`settings_app_hint_desktop` and any other) go, in every language, if nothing else uses them.

Acceptance criteria:
- In a browser (secure origin or not), General shows the App card as today.
- In the desktop app and the Android app, General shows no App card and search does not find it.
- `tests/settings-page-sections.test.tsx` (which waits for `id:settings-app`) still passes, and new tests cover the desktop and mobile runtimes hiding it; the full Console test runner passes.

## factory · plan · 2026-11-24 22:47
Behaviour: After host boot, one platform browser predicate controls the App card. Web first-run defaults, secure/insecure origins and the no-agent state retain existing behaviour. Desktop/mobile/shell runtimes render no App card or spacer; Settings search excludes its title. Other General cards and System Updates stay unchanged.

Scope: Platform predicate, General App rendering, App search entry, obsolete desktop App mode/translations and focused tests. No update-card changes or broad refactors.

Decisions: Use an explicit web-runtime and no-shell check in the platform layer, not viewport-based mobile layout detection; a browser on a small screen remains a browser. Remove the desktop-only hint in all languages. Search was found to index App, so gate it with the same predicate.

Checking: Browser secure/insecure visibility, desktop/mobile absence (including Android without a reported shell version), search visibility, existing sections tests, nsh check, full concurrent Console runner, and the configured Go gate. Manual browser/desktop/Android verification only when available.

## factory · 2026-11-24 22:47
Built and pushed c722704961e3c128cebf8d140485328433cc0f15 on factory/FT181-hide-app-card-outside-browser. Added platform isBrowser(), gated App rendering and Settings search, and removed settings_app_hint_desktop in en/zh/ja. General leaves no App placeholder outside browsers. Unrelated pre-existing unused App strings were left alone.

Tests: nsh check passed; full Console scripts/test.sh passed (164 files, 0 failed, 254 seconds); configured gate `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed, independently rerun by the manager. Regression tests cover browser secure/insecure origins and desktop/Android runtimes with/without shell versions, including a tablet. Search assertions cover desktop/tablet; phone-width search was not exercised because its search box uses pull-to-reveal.

Not checked: No manual UI inspection in a real browser, desktop app or Android device.

Installs: None; no manifest or lockfile changes. Coder reported an out-of-scope local memory note in its CLI memory directory and task output under /tmp/claude-995; these were not committed. The /tmp entry was recorded for owner-confirmed cleanup, not deleted. Temporary test HOME/cache isolation was used except that Go read the existing shared module cache with downloads disabled.

Move: new/ → review/; round 1. Awaiting review.

## factory · review · 2026-11-24 22:55
head: c722704961e3c128cebf8d140485328433cc0f15
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (base/merge-base 7c405d1b771e52fe87bd0934d6ff231ea0fb4542), all nine changed files. No findings. Browser predicate, conditional rendering with no placeholder, search exclusion, runtime initialization and locale cleanup checked.
- Required Go gate passed: gofmt clean, go vet ./..., go test ./... (168 packages ok). nsh check passed. Required concurrent Console runner passed: 164 files, 0 failed, 352 seconds; six initial parallel failures passed the runner's isolated retries. Extra core Node tests passed: 313/313.
- No installs, source edits, commits, or manifest/lockfile changes. Throwaway HOME/XDG and build caches used; the pinned shared Go module cache was read with downloads disabled.
- Not manually checked in browser, desktop or Android/iOS. No visual layout measurement; no iOS-specific test or phone-width pull-to-reveal search test. Headless regression coverage includes browser secure/insecure, desktop, Android and tablet paths.
- CLI background-task artifacts were reported outside the run directory in the shared temporary area and recorded for owner-confirmed cleanup; not deleted.
- Move: review/ → ready/. Awaiting ship.


## factory · 2026-11-25 07:20
Scheduled ship did not merge this item. Merge conflict: web/console-nsh/tests/settings-page-sections.test.tsx.
Base head before attempted merge: 018bbcd8cc6f1452f02990bd38e0d8522d95a863. Published base after this batch: 1c4ba732 (v0.3.133).
Merge aborted without code changes. Back to review/; next review must merge the current master, resolve conflicts, test and review the new head.

---
branch: factory/FT25-console-mobile-composer-tabs-sheet-transitions
round: 1
---
# Mobile composer responsiveness, voice input, tab spacing, and sheet transitions

## factory · 2026-11-08 12:18
Registered from the owner's Console request:

> Factory new bugs on mobile view:
> 1. Paste text on composer cause UI lagging for some unknown reason.
> 2. No voice input button.
> 3. The tabs component, the padding is not correct visualy.
> 4. The bottom sheets of bottom nav's 4th and 5th need animation for show and hide

Requested scope and acceptance:
- Investigate and fix mobile composer lag when pasting text. Preserve pasted content, selection, and normal editing; check both ordinary and large multiline pastes. Determine the actual cause rather than assuming one.
- Make the voice input button available and usable in the mobile composer, reusing existing voice-input behavior where available. Handle microphone permission denial and unsupported browsers explicitly without breaking text input.
- Correct mobile tabs component padding so labels/icons are visually aligned, spacing is consistent, and touch targets remain usable. Check narrow screens and overflow.
- Add smooth opening and closing animations to the bottom sheets opened by the fourth and fifth bottom navigation items. Keep sheets mounted long enough for exit animation; preserve dismissal, focus behavior, safe-area spacing, and rapid repeated toggling. Respect reduced-motion preferences.
- Add relevant regression coverage and verify mobile layouts; avoid regressing desktop behavior. Coordinate with FT23 and FT24 without expanding their scope or duplicating their fixes.

This item registers the request only; no implementation or root-cause verification has been performed.

## factory · plan · 2026-11-08 13:34
Behaviour: Preserve native paste, content and selection for ordinary and large multiline input; keep editing responsive. Reuse voice recording/transcription and explain unsupported contexts and permission failures without blocking text. Align mobile tab labels and preserve overflow/touch targets. Animate both bottom-navigation sheets in and out, retaining dismissal, focus, safe areas, rapid toggling and reduced-motion support.
Scope: Composer hot paths and existing voice integration, tabs layout, bottom sheet lifecycle/styles and regression tests. No unrelated desktop redesign or duplication of FT23/FT24 changes.
Decisions: Profile actual paste/editing paths before changing them; reuse existing voice APIs and transition patterns; choose small changes and preserve native text editing.
Checking: Go formatting/vet/tests, frontend tests/build, browser mobile checks including large paste, unsupported voice, tabs overflow and interrupted sheet transitions. Document unavailable physical-device verification.

## factory · 2026-11-08 13:34
Built and pushed four focused commits: 43af6ee8, c148287d, 64988d8f, 7a099705 (head).
- Paste: removed repeated whole-draft lowercasing, unnecessary highlight DOM and repeated full-height layout. Drafts over 10,000 characters skip colouring. Coder profiled Chromium with 4x CPU slowdown: 45 KB paste to frame improved from about 590–730 ms to 120–135 ms; subsequent typing from about 300 ms to 16 ms. Ordinary 2 KB paste lag was not reproduced.
- Voice: show configured transcription control even where microphone capture is unavailable; explain HTTPS/unsupported browser, permission denial, missing/busy microphone; guard repeated starts. Unsupported-context visibility also applies on desktop.
- Tabs: keep labels whole, scroll overflow, reveal active tabs, balance padding; use built-in equal-width option where appropriate.
- Sheets: full-height entry/exit (280/200 ms), interrupted-transition reversal, retained closing sheet without pointer interaction, instant reduced-motion changes.
Verification: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`; `pnpm test` passed 499/499; `pnpm build` passed with existing chunk-size warning. Worktree clean; commits limited to item scope; forbidden paths unchanged against cfd68a0e.
Install: temporary playwright-core@1.65.0 for existing Chromium; no manifest/lockfile changes. Pinned pnpm dependencies restored routinely.
Coder checked mobile layouts and transitions in headless Chromium, not physical devices. Not checked: iOS Safari, physical iPhone/Android, real touch tab scrolling, dark theme, successful live transcription or normal-speed CPU timings.
Test incident: coder reports one fake-audio request with a fake key accidentally reached OpenAI and returned 401; test configuration was corrected before further tests. No real provider credentials were used in that request.
Moved new/ → review/. Owner should inspect mobile appearance/interaction on real devices and verify voice transcription against their configured provider.

## factory · review · 2026-11-08 13:46
head: 7a099705c7be07f8b5b4278a606335f52b68c656
verdict: pass

Codex reviewed all 22 changed files in origin/master...HEAD against the request and plan; no verified actionable findings. Branch merges cleanly with base cfd68a0e.
Validation reported by Codex: required Go formatting/vet/tests passed; pnpm test passed 499/499; pnpm build passed with chunk-size warning. Chromium component checks passed for ordinary and 47,300-character multiline paste, content/selection/editing/undo, unsupported and denied voice input, duplicate starts and mocked transcription, narrow tab overflow, sheet open/close and rapid toggling, focus, backdrop dismissal, reduced motion and simulated safe area. Tests used temporary absolute HOME; no real provider calls. Manager verified unchanged tracked files and reviewed head.
Install: temporary playwright-core@1.65.0 (not a repository-pinned tool); repository manifests unchanged. Locked project dependencies restored.
Residual risks: component harness rather than full-app end-to-end coverage; no physical phones, iOS Safari, real soft keyboard or live transcription. Performance improvement ratios not independently remeasured. Owner should check these mobile interactions on real devices before shipping.
Moved review/ → ready/.

## factory · 2026-11-08 14:05
Owner authorized shipping ready items if fine, with a new tag and push. Reviewed head unchanged; no P0/P1 blockers. Merged into master at 011a1c7d5284733286c0d2b8826cc15d6981208f; published in v0.3.81.
Combined verification passed: Go formatting, go vet ./..., go test ./..., pnpm test (519/519), pnpm build. Existing chunk-size advisory only. No unpinned installs. Physical-device, full-app visual and live-transcription checks were not repeated during shipping; review limitations remain. No deployment.
No linked GitHub issue or PR to close. Moved ready/ → done/.

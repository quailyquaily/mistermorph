---
branch: factory/FT32-console-faster-scrolling
round: 1
---
# Console: scrolling is too slow

## lyric · 2026-11-08 23:17
Scrolling in the nsh UI is a bit slow; it should be faster.

Note: wheel and touchpad scrolling in the desktop app is handled by the nsh GPUI platform, not by `web/console-nsh`, so the fix may belong there (or in a setting the desktop shell `desktop/nsh` can pass to it).

## factory · 2026-11-09 00:05
Moved from backlog to new at the owner’s request: “Move FT 31~34 to new”.

## factory · plan · 2026-11-09 00:54
Behaviour: Increase desktop wheel/touchpad travel for the same input; preserve direction, zero input, empty/short-content bounds, gesture end and momentum. First-run defaults require no settings.
Scope: Desktop native input conversion, vendored GPUI platform, matching patch, docs and tests. Web and Android scrolling are unchanged.
Decisions: Start with a modest 2x gain applied once before dispatch; retain Wayland normalization and finger-lift handling. Avoid persistent settings and unrelated pointer/keyboard changes.
Checking: Regression tests for wheel/pixel gains, signs, zero/lift and zoom handling; Rust tests and required Go checks. Check physical wheel/touchpad feel manually.

## factory · 2026-11-09 00:54
Built and pushed f44dbf48. Linux/Windows wheel and touchpad deltas gain 2x after existing normalization; macOS remains 1x to preserve system acceleration. Ctrl-modified input retains its previous gain so zoom is unchanged (Ctrl scrolling over non-zoomable content also retains the old speed). Synthetic agent scrolls are unchanged. Added five regression tests and a reproducible vendor patch; updated desktop documentation and patch notes.
Installs: none beyond restoring pinned Cargo dependencies; no manifests/lockfiles changed for dependencies. Missing fontconfig/xkbcommon development packages were worked around using dynamic fontconfig loading and links to installed runtime libraries in temporary build files; no sudo/system install.
Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`. Coder reports desktop `cargo test --locked`: 46 passed, 1 ignored. Vendor crate tests: 207 passed (including all 5 new tests), 4 failed due to absent upstream gallery image/font fixtures; scratch-only stand-in font used. Those fixture-dependent tests remain unverified, not a complete vendor-suite pass. Console source checks not applicable (no TSX changes).
Not checked: real desktop UI/physical scroll feel, X11 and Windows behavior, or macOS execution. Owner should check wheel/touchpad speed and momentum on actual devices before shipping.

## factory · review · 2026-11-09 01:07
head: f44dbf48125d41573d8506548644dde196740c62
verdict: pass
notes:
- Codex reviewed all four changed files in origin/master...HEAD (base 6e88f224) and found no verified defects introduced by FT32. No merge conflicts with base.
- Required gofmt, go vet ./..., and go test ./... passed after normalizing the temporary TMPDIR path: 156 packages passed, 17 had no tests. The initial run had 23 failures caused by a TMPDIR containing '..'; the identical failures reproduced on base. This test-environment issue is not an outstanding FT32 P1 finding; no branch fix was made.
- Desktop cargo test --locked --offline: 46 passed, 1 ignored. Vendor library suite: 208 passed, 3 failed due to two missing image fixtures and a replacement font differing from Pacifico. All five new scrolling tests passed; the full vendor suite is not a pass.
- Applying the new vendor patch to base reproduced HEAD. git diff --check reports trailing whitespace in the patch at line 8.
- No unpinned installs, manifest edits, or lockfile changes. Rust validation used temporary dynamic-loading configuration, runtime-library links and a replacement font. Scripted tests used temporary absolute HOME directories; the worktree remained clean.
- Console source checks were not applicable. Windows/macOS execution, real wheel/touchpad feel and inertia remain unverified; check on actual devices before shipping. Linux/Windows gain is 2x; macOS stays 1x, and Ctrl-modified input stays unchanged.

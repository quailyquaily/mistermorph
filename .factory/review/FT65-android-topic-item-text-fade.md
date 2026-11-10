---
branch: factory/FT65-android-topic-item-text-fade
round: 1
---
# Android topic list: fade overflowing text at the trailing edge

## factory · 2026-11-10 10:14
Requested by the owner:
> android app 的 topic list item，如果文字比较长的话，应该像桌面端一样尾部区域渐隐

Match the desktop topic-list treatment in the Android app: when a topic item's text exceeds the available width, fade the trailing text region rather than cutting it off abruptly. Inspect and reuse the desktop behavior where appropriate.

Acceptance criteria:
- Overflowing topic text fades at its trailing edge in the Android app.
- Text that fits remains fully visible without an unnecessary fade.
- Preserve item layout, status indicators, hit targets, and desktop behavior.
- Check narrow Android layouts and long Chinese and Latin text; add suitable regression coverage and report whether Android rendering was visually verified.

## factory · plan · 2026-11-10 15:44

Behaviour: Topic titles remain one line; measured overflow fades the trailing ~34pt of text only. Fitting/empty text stays unfaded. Recompute after text/width changes; preserve status markers, row background and touch targets. First layout must settle without permanent fade; absent native mask support must be addressed in the Android rendering path, not by hiding characters.
Scope: Reuse FadeText and its desktop semantics; inspect Android renderer/build integration and patch narrowly if masks are ignored. No unrelated UI redesign or desktop behavior change.
Decisions: Use actual measured overflow rather than character count (Chinese and Latin widths differ). Keep existing fade width and theme/background-independent mask behavior; follow repository's vendored patch conventions where native changes are needed.
Checking: Regression coverage for overflow, fitting/empty text, resizing, Chinese/Latin labels and status/layout preservation. Run configured Go gate and nsh check/test. Inspect Android rendering if tooling permits; explicitly report if no device/emulator visual check is possible.

## factory · 2026-11-10 15:44

Built in 9afab800 and fd1cc140. Android nsh 0.4.0 does not render maskImage; added an Android-only measured glyph-opacity fallback in FadeText. Fitting and empty labels keep the original rendering; overflow fades over the last 34pt, with width/text changes tracked. Web/desktop mask path is unchanged. Added nine regression tests including Chinese/Latin labels, resizing, grapheme clusters, narrow rows and topic status/tap preservation.

Decisions: native runtime is prebuilt, so use text opacity rather than an unavailable native mask patch. Tail glyph splitting slightly changes kerning; verify the visual result on Android before shipping.

Installs: none. Manager verification with throwaway HOME: configured gofmt/vet/go test gate passed; nsh check passed; nsh test --web-host tests/noHost.js passed (412/412).

Not checked: Android rendering on a device/emulator; no APK built. Browser comparison is not Android visual verification. Owner should inspect long Chinese and Latin titles on selected and unselected Android rows.

Branch pushed. Initial credential-helper push failed due to missing repository path; retry with command-local credential.useHttpPath=true succeeded. Moved new/ → review/.

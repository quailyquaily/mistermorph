---
branch: factory/FT89-composer-responsive-profile-switch
round: 1
---
# Responsive selected-profile display in the composer

## factory · 2026-11-11 13:18
Recorded from the owner's UI feature request.

Request:
> The profile switch on the composer, on mobile width, shows the icon only instead of the profile name on the selected status. On desktop width, show the icon and profile name. In this way we can save space on mobile views.

Acceptance criteria:
- At mobile widths, the composer profile switch shows only the selected profile's icon; hide the visible selected-profile name to save space.
- At desktop widths, show both the selected profile icon and profile name.
- Use the existing responsive breakpoint conventions and update correctly when the viewport resizes or rotates.
- Preserve the selected profile's accessible name, keyboard operation, touch target, and existing profile-switching behavior.
- Keep names visible in the profile selection menu; only the collapsed selected-state display changes.
- Add regression coverage for mobile and desktop selected states and profile changes. Verify web and Android rendering, explicitly recording any platform not actually checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 16:16
Behaviour: Keep existing picker visibility and selection rules, including zero/one profile. Mobile collapsed state shows the selected icon/fallback and caret, with full accessible name; desktop also shows the name. Resize and rotation update reactively. Menu names and error handling stay unchanged.
Scope: Composer selected trigger and focused regression tests; no menu redesign.
Decisions: Reuse shell isMobile and existing profile image/CPU fallback, with no new breakpoint or configuration. Keep the caret to identify the menu.
Checking: Cover mobile/desktop selection, breakpoint transitions, menu and accessible names, and single-profile absence. Run repository and Console checks; inspect web rendering and report unavailable platforms.

## factory · 2026-11-11 16:16
Built in 90d68632 by Claude Code. Shared profile glyph between trigger and menu; the selected name hides at the existing <=980 breakpoint. Accessible label, tooltip, keyboard behavior and menu names remain intact. Existing 32-point trigger height is unchanged; mobile width measured 45 points.
Added five regression tests covering desktop/mobile profile changes, 980/981 transitions, portrait/landscape, simulated Android and single-profile absence.
Tests: gofmt check, go vet ./..., go test ./... passed; manager independently reran the required Go checks successfully. Coder reports nsh check and all 626 nsh tests passed, with throwaway HOME.
Web checked by coder in Chrome on an isolated real-composer page: desktop/mobile, resizing, menu selection, accessible names and keyboard operation. Full Console browser integration, native desktop app, and Android device/emulator rendering were not checked; Android coverage is simulated only.
Installs: none.
Branch push initially required credential.useHttpPath=true; retried successfully with command-local credential settings.
Moved new/ → review/ for review; not merged or released.

## factory · review · 2026-11-11 16:44
head: 90d6863203692e1b56a5643139a9605970d6bb8a
verdict: pass
notes:
- Claude Code reviewed every hunk of origin/master...HEAD (base 7a63c01a), two files. No findings. Clean merge with master verified.
- Validation: gofmt check, go vet ./..., go test ./..., and nsh check passed; nsh test --web-host tests/noHost.js passed all 626 tests, including five new regression tests. Tests used throwaway HOME. Additional glyph-switch probe passed both desktop and mobile cases.
- No installs. Code HEAD unchanged and worktree clean after review.
- Review did not inspect real browser, desktop app, Android device/emulator rendering, or measure touch target dimensions; Android coverage is headless simulation only.
- Moved review/ → ready/; not merged or released.

## factory · 2026-11-11 20:54
Shipped with owner authorization using Claude Code. Merged into master: 0bf210b86dd598878e16a23fe7bd52d3084a1eb2. Pushed master through b541d3f4. No tag created or pushed, as explicitly requested.
Validation: Go formatting, go vet ./..., go test ./..., nsh check and Console suite passed after each merge; final suite 646 passed, 0 failed. FT89 suite required rerun after external termination; FT90 drag test timed out once, then passed five isolated runs and the full rerun. No installs. No device/emulator or browser visual checks during shipping. Existing FT90 keyboard-selection and disabled-trigger limitations remain follow-ups. No linked issues or PRs to close. Moved ready/ → done/.

---
branch: factory/FT161-bottom-nav-primary-color
round: 1
---
# Match selected bottom-nav icons to the primary button color

## factory · 2026-11-19 19:46
The owner confirmed that selected bottom-navigation icons should use the same theme color as primary button backgrounds and requested adding this task to new/ for the factory to implement.

### Current behavior
- In `web/console-nsh/components/frame/MobileBottomNav.tsx`, selected navigation icons use the `blue` theme token.
- In `web/console-nsh/theme.json`, `blue` is `#426f9e`, whereas `primary` is `#284e78`; primary buttons use `bg-primary`.
- Consequently, selected bottom-navigation icons appear lighter than primary button backgrounds.

### Required behavior and scope
- Use the semantic `primary` theme token for selected bottom-nav icons rather than `blue` or a hard-coded hex value, so their color follows the primary button background as themes change.
- Inspect active primary-page and More navigation states and apply the same selected-icon rule wherever applicable.
- Preserve inactive, disabled, warning/error, and other unrelated icon colors and behavior. Do not globally change the `blue` token or primary button styling.
- Preserve navigation, layout, touch targets, and existing transitions.

### Verification
- Add or update focused regression coverage for the selected/unselected token choice using the repository's existing test conventions.
- Run the configured repository checks and required Console checks/tests.
- Visually compare selected bottom-nav icons with primary buttons in supported themes and navigation states where feasible. Explicitly report any visual checks not performed.

## factory · plan · 2026-11-19 21:02
### Behaviour
Selected primary-page and More icons use the semantic primary token; unselected icons keep muted-foreground. More opening/closing, secondary-route selection and agent selection retain existing behavior. Initial-route handling remains unchanged.
### Scope
MobileBottomNav selected-icon colors and focused regression coverage only. Leave the blue highlight pill, avatar, shared navigation lists, theme definitions, primary buttons, layout and transitions unchanged.
### Decisions
Replace selected blue with primary rather than hard-coding a hex color. Use a local tint function shared by color and test IDs because headless nsh cannot query image tint directly; no shared API changes.
### Checking
Cover initial primary route, primary navigation, More open/close, a secondary route and agent selection. Run nsh check, the required parallel Console runner and configured Go formatting/vet/tests. Report visual checks not performed.

## factory · 2026-11-19 21:02
Built and pushed commit 50b06191 on factory/FT161-bottom-nav-primary-color. Moved new/ → review/; round 1.
- Selected primary-page and More glyphs now use primary; inactive glyphs retain muted-foreground. Highlight pill and unrelated styling/behavior unchanged.
- Added two regression tests: light/dark token expectations and live Console navigation-state coverage. Tint-bearing test IDs follow existing repository convention. Temporarily restoring blue made the runtime regression fail as expected.
- Tests: nsh check passed; required scripts/test.sh passed, 146 files, 0 failed (chat-attachments passed isolated runner retry); configured gofmt/vet/go test passed. Manager independently reran configured Go checks, nsh check and both focused tests successfully.
- Installs: none; no manifest changes.
- Not checked: no visual screenshots, live browser comparison, Android device/emulator or native desktop inspection. Headless tests verify selected tokens and navigation behavior, not rendered pixels. Review should assess visual matching in both themes.

## factory · review · 2026-11-19 21:31
head: 50b061918d5050bdabe911fe611f13e9a8194a8d
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (two changed files); no findings at any priority. Selected primary-page and More icons resolve the same semantic primary token as primary button backgrounds. Inactive colors, highlight pill, avatar, navigation and layout remain unchanged.
- Validation: configured gofmt/vet/go test passed; nsh check passed (installed nsh 0.6.0); required parallel Console scripts/test.sh passed, 146 files, 0 failed. settings-page, settings-menus and dialog-sheet passed isolated runner retries after parallel failures. Focused navigation regression fails against base as expected.
- Installs: none; no manifest changes. Worktree clean at reviewed head.
- Limits: no rendered visual comparison, browser/native screenshots or device checks. Headless tests assert tint-bearing IDs sharing the color helper rather than rendered pixels; changing color independently of the ID could escape those tests. Agent-sheet open/close is covered, not selecting another agent.
- Moved review/ → ready/. No merge or release performed.

## factory · 2026-11-20 10:25
Shipped: merged into master as 8bfb0dd682b85682b6ea2fd87cb13d9a82ef9987, tagged v0.3.122 and pushed. No linked GitHub issues or PRs to close. Branch kept (the ship does not delete branches here).

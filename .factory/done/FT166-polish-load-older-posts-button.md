---
branch: factory/FT166-polish-load-older-posts-button
round: 1
---
# Polish the Load older posts button

## factory · 2026-11-20 10:20
Owner requests visual polish for the button used to load older posts/history, including the mobile app experience.

### Required behavior
- Identify the existing older-posts/history loading control in the Console and polish its appearance to match the surrounding UI and current shared button styles. Reuse existing components and tokens rather than introducing a new button system.
- Improve corner treatment, spacing, alignment, typography, and interaction states. Keep the control visually restrained but clearly actionable, with a comfortable mobile touch target.
- Ensure the button looks correct in mobile apps, mobile web, and desktop layouts, including supported themes. Avoid clipping or overlap with surrounding content and safe areas.
- Preserve pagination, chronological order, scroll anchoring, and loaded content. Show a clear loading/disabled state and prevent duplicate requests; retain existing error/retry and end-of-history behavior.

### Acceptance checks
- Check default, hover/focus/pressed where applicable, loading, failure/retry, and no-more-history states. Preserve keyboard accessibility and an accessible label.
- Add or update focused regression coverage for any changed behavior; run existing history-loading/scroll-anchor tests when touching those paths.
- Record which visual/device checks were actually performed; do not claim native-device verification from source inspection alone.

## factory · plan · 2026-11-20 11:15
### Behaviour
Use the existing OlderBoundary shared plain Button between faint rules. Provide a real 44pt phone target, stable idle/loading dimensions, accessible loading and blocked repeated presses; retain retry and hide the row when history is exhausted.

### Scope
Limit changes to the history boundary and its focused test/fixture; leave pagination, chronological order, controller and scroll-anchor algorithms unchanged.

### Decisions
Reuse shared Button sizes and themed tokens rather than a new variant; keep HISTORY_OLDER_ROW_HEIGHT at 44 as a minimum, allow long labels to wrap, and give keyboard focus the existing hover fill. Use repository-pinned nsh 0.6.0 instructions rather than the board comment's stale version.

### Checking
Run the Go formatting/vet/test gate, nsh check, the required parallel Console suite, focused older-history and scroll-anchor coverage. Record actual screenshot checks separately from native-device verification.

## factory · 2026-11-20 11:15
Built and pushed commit `2e1a5c85` on `factory/FT166-polish-load-older-posts-button`.
- Mobile-width button uses shared 44pt md size; desktop uses 38pt sm. Label grows to 14pt; equal rule gaps are 8pt. Existing shared corner/loading treatment retained.
- Local visible keyboard-focus fill; long labels wrap with minimum rule stubs rather than clipping. Row may grow for wrapping; no pagination or scroll algorithms changed.
- Extended focused layout/loading/blocked-press/keyboard tests (10 pass); chat-scroll-anchor tests pass. `nsh check` passes. Required Console `scripts/test.sh`: 148 files, 0 failed, followed by focused/type checks after a comment-only edit.
- Go gate passes, independently rerun by manager. Coder's first run hit unrelated random-secret substring flake in `internal/wechatlogin/TestLoginFollowsARedirectAndSavesTheCredentials`; isolated five-repeat and full rerun passed without changes to that package.
- Installs: none; no manifest/lock changes.
- Actual visual checks: fixture screenshots in headless Chrome at 1000pt desktop and 390pt touch, idle/hover/focus/loading/long-label, compared to old look. Screenshots used installed nsh 0.5.1 web runtime, not pinned 0.6.0; acceptance on current native runtime still needs owner inspection.
- Not checked visually: pressed state, dark theme (Console pinned light), full Console page, safe areas separately, desktop GPUI, Android/iOS emulator or device. Native layout tests are not native-device verification.
- Manager's first push lacked repository credential path; retry with command-local credential.useHttpPath=true succeeded. No settings changed.
Moved from `new/` to `review/`, round 1. Owner should inspect the full Console on current native/mobile runtime, especially wrapping, focus and touch appearance.

## factory · review · 2026-11-20 11:30
head: 2e1a5c858083424eb641a1e89e368c0920063e1d
verdict: pass
notes:
- Claude Code reviewed all three changed files against origin/master, the request and plan; no qualifying findings. Pagination, chronological order, scroll-anchor behavior, loading/blocked presses, keyboard access, accessible labels and shared button reuse were checked.
- Required Go gate passed: gofmt clean, go vet ./... and go test ./... exit 0 (166 packages ok). nsh check passed on pinned nsh 0.6.0 (5541637).
- Required parallel Console scripts/test.sh passed: 148 files, 0 failed. settings-page and settings-agent-name-set passed the script's solo retry after initial parallel failures; base comparison was not run. Older-history and scroll-anchor tests passed.
- Installs: none; existing cached TypeScript copied into temporary test HOME. No manifest/lock or code changes; reviewed worktree clean.
- No new screenshots or native-device checks. Owner should inspect the full Console on pinned runtime: focus/pressed appearance, mobile/safe-area behavior and wrapping. Build screenshots used older 0.5.1 web runtime. Wide touch windows above 980pt use the planned desktop 38pt size rather than the mobile 44pt size.
- Coder commands used run-scoped temporary directories; Claude's own harness reported writing background-task output outside the run directory. Those shared temporary paths were not deleted.
Moved from `review/` to `ready/`.

## factory · 2026-11-20 20:34
Shipped: merged into master as 5d17fcd32c62ef15983b9254514552270c26c435, tagged v0.3.123 and pushed. Merged master passed nsh check, the Console scripts/test.sh (152 files, 0 failed) and the test command (gofmt, go vet, go test: 166 packages). No linked GitHub issues or PRs to close. Branch kept (the ship does not delete branches here).

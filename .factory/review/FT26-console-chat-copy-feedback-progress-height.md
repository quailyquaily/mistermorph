---
branch: factory/FT26-console-chat-copy-feedback-progress-height
round: 1
---
# Chat inline-code copying, copy feedback, and progress height alignment

## factory · 2026-11-08 12:22
Registered at the owner's request in new/; implementation has not started.

Owner's request:
> 1. Click the code span at the chat view should copy the content.
> 2. The copy button at the chat bubble is lack of animation.
> 3. The progress box and the scrolling area, their height should be same.

Acceptance criteria:
- Clicking or tapping an inline code span in a chat message copies its text content, without Markdown backticks, to the clipboard. Provide keyboard-accessible activation and successful-copy feedback; handle clipboard failures without claiming success. Preserve existing fenced-code copying and ordinary text selection.
- Add a brief visible animation/transition to the chat bubble copy button on successful copy, returning to its normal state afterwards. Repeated activation must work; respect reduced-motion preferences and do not shift the bubble layout.
- Align the progress box height with its associated scrolling area so their visible bounds match, without extra blank space or clipped content. Verify on mobile and desktop, including viewport resizing and progress updates; preserve scrolling behavior and avoid unexpected topic scroll jumps.
- Add regression coverage for copy behavior and feedback state. Check the visual height alignment and animation in the UI; explicitly report any visual checks that cannot be performed.

Scope: register these chat/progress UI fixes only; coordinate with FT24's progress styling and scroll-stability work rather than duplicating or undoing it.

## factory · 2026-11-08 13:28
Moved from new to backlog at the owner’s request: “move FT 26~29 to backlog”.

## factory · 2026-11-08 19:36
Moved from backlog to new at the owner’s request: “FT26, 27 放到 new”.

## factory · plan · 2026-11-08 20:19
Behaviour: Activate chat inline code with a pointer or Enter/Space to copy its text, show temporary success only after copying succeeds, preserve selection and fenced-code copying, and report failures honestly. Bubble copy feedback must replay on repeated successes, reset cleanly and respect reduced motion without layout shifts. Progress box and scroll viewport must share bounds on resize and updates, with no empty box or topic scroll jumps.

Scope: Markdown copy handlers and styles, chat bubble feedback, progress layout, and focused regression coverage. Preserve FT24 chat scroll-following; no unrelated backend or UI changes.

Decisions: Reuse existing renderer copy support rather than add a duplicate handler; exclude code inside links or controls. Prefer CSS sizing to measurement; verify clipboard fallback results and restore focus/selection. Keep existing success icon and make repeated feedback reliable.

Checking: Cover success/failure, keyboard, selection, link and fenced-code exclusions, repeated feedback and cleanup, progress bounds and resize behavior. Run factory Go checks, console tests/build, renderer tests, and desktop/mobile browser checks where available.

## factory · 2026-11-08 20:19
Built and pushed commits 2e20211a, bf9e6e48 and 6733cf81; moved new → review, round 1.

Inline code now preserves links and drag selection, provides longer replayable feedback, and restores focus/selection in the clipboard fallback. Bubble copy animation replays on each success and no longer claims success after a failed fallback; fixed its undefined accent-color variable. Progress panel and list share one viewport-bounded height, retain the latest entry through resize, and omit an empty expanded plan box. Existing FT24 topic scroll-following remains unchanged.

The renderer already supported inline copying, so its implementation was fixed in both source and bundled console assets; a parity test checks synchronization. The full renderer build produces unrelated changes, which were discarded.

Tests: console 537/537; renderer 10/10; pnpm build passed (existing chunk-size warning); factory `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed. Manager independently reran the factory checks and console tests/build successfully. Scripted tests used a throwaway HOME.

Visual checks: coder checked actual components/styles with mock data in system Chrome at desktop 1280×860 and mobile 390×760, 12 updates and four resizes, copy/keyboard/selection/failure/fallback interactions, repeated animations, stable message heights and reduced motion. Original progress mismatch was not reproduced naturally in Chrome: forced intrinsic expansion demonstrated the protection (707px extra space before, none after), not a confirmed reproduction of the owner's browser issue.

Installs: temporary playwright-core@1.65.0 via package manager to drive installed Chrome; no manifest or lockfile changes. Other restored dependencies were pinned.

Not checked: WebKit/Safari, physical mobile devices, or the full app with a real backend. Owner/reviewer should verify the original progress-height issue on the affected browser and inspect copy animations.

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

# Match mobile back buttons to the Todo calendar button

## factory · 2026-11-11 13:50
Recorded from the owner's UI fix request.

Request:
> The back button on mobile views seems to have different sizes compared to other buttons on the page bar. Looks smaller. Need to fix, to use the same size like the Todo view's calendar button.

Acceptance criteria:
- Audit mobile page-bar back buttons and match their button dimensions, icon size, padding, and alignment to the Todo view's calendar button.
- Prefer shared sizing styles over per-page overrides. Preserve accessible touch targets, labels, back navigation, and desktop layouts.
- Add regression coverage for consistent sizing. Visually compare affected mobile pages with the Todo calendar button on mobile web and Android; explicitly record any platform not checked.

Implementation: Claude Code only; do not use Codex.

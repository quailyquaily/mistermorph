# Fix the default-profile dropdown in Settings → Models

## factory · 2026-11-11 13:31
Recorded from the owner's UI fix request.

Request:
> The settings -> models, the default profile top right drop-down, cannot popup.

Acceptance criteria:
- Reproduce and fix the top-right default-profile dropdown failing to open in Settings → Models.
- The menu opens by pointer, touch, and keyboard, remains visible above surrounding UI, and allows selecting and saving the default profile.
- Preserve current selection, dismissal, focus handling, and existing settings behavior.
- Add regression coverage for opening and selecting; verify desktop web, mobile web, and Android app behavior, explicitly recording any platform not actually checked.

Implementation: Claude Code only; do not use Codex.

# Composer single-line placeholder must never wrap

## factory · 2026-11-11 00:34

Recorded from the owner’s explicit request to add this correction to `new/`.

The owner reports another incorrect composer layout behavior: in single-line mode, a long placeholder may be truncated with an ellipsis but must not wrap.

### Acceptance criteria

- While the composer is in single-line mode, keep its placeholder on exactly one visual line. Use ellipsis when the available width is insufficient.
- Placeholder length must not increase composer height or trigger multiline mode; actual user text must retain the intended multiline behavior.
- Check narrow widths and long localized placeholders, including an empty composer after clearing a multiline draft.

Intake only; implementation has not started.

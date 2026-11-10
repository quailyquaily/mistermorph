# Composer multiline mode must immediately use the full multiline text width

## factory · 2026-11-11 00:34

Recorded from the owner’s explicit request to add this correction to `new/`.

Follow-up to shipped FT69. The owner reports that the previous fix retains the single-line text-field width after entering multiline mode, apparently to keep wrapping triggered. This leaves an unacceptable intermediate layout.

### Acceptance criteria

- On entering multiline mode, immediately apply the intended full multiline text-field width together with the rest of the multiline layout. Do not retain the single-line width to force wrapping.
- Keep mode transitions stable even when the expanded width makes the text fit on one visual line. Define clean entry and exit conditions without intermediate states, oscillation, or height/width flicker.
- Cover typing near the wrap threshold, deletion, pasted text, explicit newlines, IME composition, and resizing. Verify rendered width and layout, not only a mode flag.

Intake only; implementation has not started.

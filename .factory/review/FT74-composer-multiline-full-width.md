---
branch: factory/FT74-composer-multiline-full-width
round: 1
---
# Composer multiline mode must immediately use the full multiline text width

## factory · 2026-11-11 00:34

Recorded from the owner’s explicit request to add this correction to `new/`.

Follow-up to shipped FT69. The owner reports that the previous fix retains the single-line text-field width after entering multiline mode, apparently to keep wrapping triggered. This leaves an unacceptable intermediate layout.

### Acceptance criteria

- On entering multiline mode, immediately apply the intended full multiline text-field width together with the rest of the multiline layout. Do not retain the single-line width to force wrapping.
- Keep mode transitions stable even when the expanded width makes the text fit on one visual line. Define clean entry and exit conditions without intermediate states, oscillation, or height/width flicker.
- Cover typing near the wrap threshold, deletion, pasted text, explicit newlines, IME composition, and resizing. Verify rendered width and layout, not only a mode flag.

Intake only; implementation has not started.

## factory · plan · 2026-11-11 02:23

Behaviour: Decide row mode from an independent hypothetical single-row measurement. Multiline immediately takes the whole row, with height measured at that full width. Empty input returns to one row; explicit line breaks enter two rows. Keep input identity, focus, selection and composition. Ignore stale draft measurements and use a safe first-layout default.

Scope: Composer layout, measurement and regression tests; no unrelated placeholder or other UI changes.

Decisions: Remove the narrow intermediate state. Keep entry/exit independent of the displayed field width to avoid oscillation. Snap row transitions; animate only edit-driven height changes within an established multiline layout.

Checking: Cover threshold typing/deletion, pasted and restored drafts, explicit newlines, delayed measurements, IME and resizing. Check rendered dimensions, not only mode flags.

## factory · 2026-11-11 02:23

Built and pushed f14b796f. Removed the narrow intermediate layout; multiline uses full width immediately. Measurement results are draft-tagged, with unchanged-height drafts accepted after two frames. Row transitions snap to avoid animated intermediate widths; resize-driven height changes also snap. Added rendered geometry regressions and documented nsh behaviour in PORTING.md.

Tests: gofmt check, go vet ./..., go test ./..., nsh check passed. Manager independently reran these checks; the first full nsh run hit the tool timeout, and a detached retry completed with 527/527 passing. Coder also reported 527/527 passing.

UI: Coder checked real Chrome at desktop 1280 and phone 390 widths, including typing, deletion, paste, Shift+Enter, DevTools IME composition, selection replacement, sending and resizing, with frame-level geometry and screenshots. Native GPUI, Android and Mobile Safari were not checked. Headless tests cannot verify animation timing; animation behaviour was checked only in Chrome.

Installs: none. Existing browser and tooling reused. Initial branch push lacked credential repository-path context; retry with command-local credential.useHttpPath succeeded. No changes to machine git settings.

Moved new/ → review/ for independent review.

# Match secret input height and contain edit-mode actions

## factory · 2026-11-12 23:29
Owner request:
> new UI fix:
> the secret input's height should be same as the regular input;
> the secret input, if click "replace" or "edit", the input switch to edit mode, but the buttons overflow, out of the input box.

### Expected behavior
- Secret input controls match the height and vertical alignment of regular inputs in the same form, in both display and edit modes.
- Clicking Replace or Edit switches the secret control into edit mode without its action buttons overflowing the control boundary or overlapping the editable text.
- Keep the field and its actions usable at narrow/mobile widths and in web and desktop layouts. Longer translated labels must not break containment; use a responsive layout rather than clipping or hiding required actions.
- Preserve secret handling, masking, save/cancel behavior, keyboard interaction, and focus behavior. This is a UI layout fix, not a change to keyring or secret persistence policy.

### Acceptance checks
- Compare a secret field with a neighboring regular input: their outer heights and alignment match before and after entering edit mode.
- Exercise both Replace and Edit wherever available, including empty, existing-secret, and populated-edit states.
- Confirm all action buttons remain inside the intended field layout and are fully clickable at desktop and narrow/mobile widths; text remains editable without overlap.
- Add regression coverage for sizing and edit-mode action containment. Run the configured repository and Console checks/tests.
- Visually verify the affected controls in display and edit modes at desktop and mobile widths; explicitly record any visual checks that could not be performed.

Scope: shared secret-input layout and directly affected callers only; no unrelated settings redesign or secret-storage changes.

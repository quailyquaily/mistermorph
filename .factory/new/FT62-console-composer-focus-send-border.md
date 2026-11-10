# Keep the composer light border visible on focus and after sending

## factory · 2026-11-10 09:03

User request:
> The focused composer also needs the light border, and when click send it has the beam but still doesn't have the beam. I click back and enter the topic again, the light border of composer comes back

Follow-up to FT50. The composer must retain its subtle, design-consistent border while focused and after sending, without requiring the user to leave and reopen the topic.

Acceptance criteria:
- Preserve the light composer border in idle, focused, and post-send states, including mobile keyboard transitions.
- Reproduce the reported sequence: focus the composer, type, send, then compare its border with the appearance after leaving and reopening the topic. Fix inconsistent rendering/state rather than relying on navigation to restore it.
- Keep the existing send and keyboard-dismiss behavior; do not force focus just to restore styling.
- Check mobile and desktop and add regression coverage for focus/send state transitions where practical.

The phrase "has the beam but still doesn't have the beam" is ambiguous; it is preserved above rather than treated as a confirmed caret defect. The actionable reported issue is the missing light border that returns after re-entering the topic.

Registered for implementation; not yet diagnosed or implemented.

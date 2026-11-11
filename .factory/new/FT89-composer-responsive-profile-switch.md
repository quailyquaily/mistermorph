# Responsive selected-profile display in the composer

## factory · 2026-11-11 13:18
Recorded from the owner's UI feature request.

Request:
> The profile switch on the composer, on mobile width, shows the icon only instead of the profile name on the selected status. On desktop width, show the icon and profile name. In this way we can save space on mobile views.

Acceptance criteria:
- At mobile widths, the composer profile switch shows only the selected profile's icon; hide the visible selected-profile name to save space.
- At desktop widths, show both the selected profile icon and profile name.
- Use the existing responsive breakpoint conventions and update correctly when the viewport resizes or rotates.
- Preserve the selected profile's accessible name, keyboard operation, touch target, and existing profile-switching behavior.
- Keep names visible in the profile selection menu; only the collapsed selected-state display changes.
- Add regression coverage for mobile and desktop selected states and profile changes. Verify web and Android rendering, explicitly recording any platform not actually checked.

Implementation: Claude Code only; do not use Codex.

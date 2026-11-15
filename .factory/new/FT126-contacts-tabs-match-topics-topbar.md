# Contacts top tabs: match Topics topbar styling and alignment

## factory · 2026-11-15 14:02

Owner request:
> These 2 buttons tabs at the contacts page top should follow the style at the topics page top: height, circle selected, the bottom edge align with the topbar bottom.
> Add to new/

Follow-up to shipped FT125 (Agent/Human tab styling). Keep FT125 in done/; this item tracks the remaining visual mismatch.

Acceptance criteria:
- Use the Topics page top tabs as the visual reference for the Contacts page Agent/Human tabs, rather than introducing a new tab style.
- Match tab height and the circular selected-state treatment shown on Topics.
- Align the bottom edge of the Contacts tab strip with the bottom edge of the topbar; remove any unintended gap or vertical offset.
- Verify both selected states on mobile and desktop, including narrow viewports, without clipping or overflow.
- Preserve filtering, labels/tooltips, keyboard navigation and accessible selected-state semantics.
- Add regression coverage for tab geometry and selected-state presentation, and visually compare the full Contacts and Topics topbars.

Scope: record this UI bug for implementation; no implementation in this intake request.

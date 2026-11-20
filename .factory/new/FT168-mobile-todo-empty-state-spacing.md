# Add horizontal margins to the mobile TODO empty placeholder

## factory · 2026-11-20 14:50
The owner requested: "the Todo empty placeholder on mobile need left and right margin." Add this to new/ for the factory to implement.

### Current behavior
The supplied mobile screenshot shows the Scheduled section's dashed "No scheduled TODOs" placeholder extending to both screen edges, while its section heading is inset. The placeholder needs space outside its left and right borders, not merely more padding inside the card.

### Requirements
- Give the TODO empty placeholder consistent left and right outer spacing on mobile, using the Console's existing page gutters/spacing tokens and aligning it with neighboring section content.
- Keep the empty-state text and add-task action intact and usable. Avoid horizontal overflow or clipping at narrow viewport widths.
- Preserve desktop layout and populated TODO lists; do not redesign unrelated sections.
- Check the mobile empty state at representative narrow widths, including approximately 320px and 390px, and ensure desktop behavior is unchanged. Add focused regression coverage where practical; report any visual checks not performed.

### Reference
See `.factory/references/FT168/mobile-todo-empty-state.png` for the owner's screenshot.

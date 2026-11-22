# Expand and compact mobile bottom navigation with scroll direction

## factory · 2026-11-23 08:13
The owner approved the discussed mobile UX and requested: "Ok. Cool, this is a good ux. Add to new/"

### Agreed direction
On mobile root pages, keep navigation available while reducing its footprint during downward browsing. The current icon-only capsule is the compact state; add an expanded state with destination labels. This is not a hide-on-scroll navigation bar.

### Requirements
- Start expanded, showing icons and localized destination labels. Scrolling downward into content switches to a smaller icon-only capsule; scrolling upward expands it again. At the top of the content, always expand.
- Track the page's actual content scroll container, including nested scrolling where applicable. Accumulate meaningful movement before switching states; ignore tiny reversals and elastic overscroll to avoid jitter. Use a reasonable threshold chosen during implementation and document it.
- Keep all existing navigation destinations, selected-state styling, hit targets, keyboard access, and accessible names in both states. Navigation must remain visible and usable throughout the transition.
- Handle the existing agent/avatar entry deliberately: retain its function and identity without forcing an inappropriate destination label onto it.
- Reset to expanded on top-level destination changes. Clear stale scroll direction/offset when the active scroll container or route changes. Pages without enough content to scroll stay expanded.
- Use a short, restrained transition, respecting reduced-motion preferences. Do not let capsule resizing shift page content, overlap required controls, or ignore bottom safe-area insets.
- Limit changes to mobile bottom navigation and its scroll-state integration. Keep desktop navigation, subpage navigation visibility/back behavior, theme palette, and unrelated component visuals unchanged.

### References
- ../references/FT172/bottom-nav-reference-1.png
- ../references/FT172/bottom-nav-reference-2.png
These are static examples of expanded/compact appearance, not evidence of timing or scroll direction. The direction above is the interaction the owner approved after discussion.

### Acceptance checks
- Real mobile-sized browser verification on a scrollable root page: expanded initially, compact after sustained downward movement, expanded after sustained upward movement, and expanded at the top.
- Check small scroll reversals, overscroll, short/empty pages, switching destinations at a nonzero scroll position, safe-area layout, and the avatar entry.
- Add regression tests for thresholds/hysteresis, top-of-page and route/container reset, and accessible navigation in both states. Verify reduced-motion behavior and unchanged desktop/subpage navigation.
- Capture actual expanded and compact mobile screenshots; report any browser/native-device behavior that was not verified.

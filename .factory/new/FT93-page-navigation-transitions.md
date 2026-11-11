# Add directional page and bottom-navigation transitions

## factory · 2026-11-11 13:50
Recorded from the owner's UI fix request.

Request:
> And we should add transitions for all page switching, for example, when entering or going back to the page, use the slide in and out, when switching pages on bottom nav, use the scrollable-tiling like transition.

Acceptance criteria:
- Audit page navigation and apply consistent transitions: entering a nested page slides it in from the right; going back reverses the motion, sliding it out to the right and revealing the previous page.
- Bottom-navigation switches use a horizontal, adjacent-page sliding transition, like a scrollable strip of tiles. Direction follows tab order; outgoing and incoming pages move together rather than fading or animating as dialogs. This request does not require adding swipe-to-navigate gestures.
- Cover navigation via page controls, bottom tabs, browser history, and Android back where supported; avoid animating initial load as a back/forward action.
- Keep outgoing content mounted through exit without duplicate interactive controls; handle rapid navigation, cancelled transitions, loading/error states, and viewport changes without stale pages or blank frames.
- Preserve route/history semantics, per-page scroll behavior, focus/accessibility, bottom-nav positioning, keyboard and safe areas. Respect reduced-motion preferences with immediate or reduced-motion switches.
- Use shared navigation transition handling; coordinate with FT91's dialog transitions without treating sheets as pages.
- Add regression tests for forward/back direction, tab-order direction, rapid switches, and reduced motion. Verify mobile web and Android visually, plus desktop non-regression; explicitly record any platform not checked.

Implementation: Claude Code only; do not use Codex.

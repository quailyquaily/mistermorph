# Show mobile bottom navigation only on root pages

## factory · 2026-11-12 17:06
Owner request:
> New UI fix: on mobile view, only show bottom nav on the root pages.
> For example show at the contacts list page, not the contacts details page

### Expected behavior
- In the Console mobile layout, show the bottom navigation only on top-level/root pages.
- Show it on the contacts list page; hide it on a contact details page.
- Apply the same distinction consistently to other sections: nested detail and subpages must not show the mobile bottom navigation.
- Update visibility correctly on direct entry, refresh, in-app navigation, and browser back/forward navigation.
- When the bottom navigation is hidden, remove any layout space or padding reserved exclusively for it, while preserving safe-area spacing where needed.
- Keep desktop navigation and existing page back navigation unchanged.

### Acceptance checks
- At a mobile viewport, confirm the contacts list shows the bottom navigation and opening a contact hides it; returning to the list restores it.
- Check root and nested routes across the other Console sections, including direct loads and browser back/forward navigation.
- Verify nested pages have no empty bottom-navigation gap or obscured content.
- Add regression tests for root versus nested route visibility and navigation between them.
- Run the configured repository checks and the Console checks/tests. Record whether the mobile UI was visually verified.

Scope: UI navigation visibility and its layout spacing only. No navigation redesign or route restructuring.

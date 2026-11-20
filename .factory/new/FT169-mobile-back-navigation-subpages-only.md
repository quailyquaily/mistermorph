# Show mobile back navigation only on subpages

## factory · 2026-11-20 23:29
The owner requested: "On mobile view, only the sub page has a back action (and geasture), root page has no back action" and asked to add this to new/.

### Requirements
- On mobile, show and enable the page back action only for subpages with an in-app parent.
- Root pages such as Topics, Contacts, and TODO must have no page back action and must not activate the app's back/swipe-back gesture.
- Apply the same page-hierarchy rule to the visible back control and the app-managed back gesture. Do not use browser-history length alone to decide: arriving at a root page from another page must not give that root page a back action.
- Subpages retain a working back control and back gesture that return to their appropriate parent, including when opened directly.
- Keep desktop navigation and unrelated gestures unchanged. Do not attempt to override the browser/OS's native back navigation; this request concerns app-provided controls and gesture handlers.

### Acceptance checks
- At mobile widths, root pages have neither a back control nor an app-handled back gesture, including after switching between top-level destinations.
- Subpages have both working back controls and app back gestures; returning to a root removes both.
- Cover direct-entry subpages, root/subpage transitions, and gesture eligibility with regression tests; verify representative mobile routes visually.

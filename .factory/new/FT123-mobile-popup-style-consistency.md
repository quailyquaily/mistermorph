# Mobile popups: shared More-menu and agent-switcher presentation

## factory · 2026-11-15 08:59

Owner request:
> On mobile, all popups (desktop-style dropdown menus, dialogs, and popup bubbles such as bottom nav More) should follow the More menu and agent switcher: rounded top-left/top-right corners, small side margins, slide in from top, safe area.
> Write down to design/ and add to new/.

Design specification: `design/mobile-popups.md` on `master` (also indexed in `design/README.md`).

Acceptance criteria:
- Inventory all app-controlled mobile menus, dialogs, and popovers; apply the shared More-menu/agent-switcher presentation to every category, not just navigation popups.
- Use consistent rounded top corners, small left/right margins, reference surface styling, and a slide-in-from-top entrance. Match the visual reference without changing the requested motion direction.
- Respect safe-area insets, bottom-nav clearance, narrow widths, landscape, and software keyboard changes; constrain tall content and keep actions reachable through internal scrolling.
- Preserve popup behavior, accessible names/roles, focus handling, appropriate dismissal, readable text, and touch targets; respect reduced motion. Leave native OS/browser pickers native.
- Keep desktop presentation and behavior unchanged.
- Add regression coverage for representative menu, dialog, and bubble/popover cases, including More and the agent switcher, and verify safe areas, overflow, entrance direction, keyboard, and desktop behavior.
- Keep the design document consistent with the implementation.

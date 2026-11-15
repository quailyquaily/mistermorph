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


## factory · 2026-11-15 09:20

Updated owner request (supersedes the earlier top-corners-only and side-margins-only requirements):
> On the mobile view, all popups (popup menus like desktop dropdowns, dialogs, and popup bubbles like the bottom navigation More button trigger) should follow the design and style of More and the agent switcher: round corners on all corners, small margins on the left, right, and bottom, slide in from top, safe area.
> Write a design file and add this request to new status.

Keep FT123 in `new/`; this is an update, not a duplicate request. The revised design document is `design/mobile-popups.md`. Ensure this document is included/updated in the implementation branch; do not assume the earlier note saying it is indexed on master proves that it is present there.

Updated acceptance criteria:
- Round all four corners on every app-controlled mobile menu, dialog, and popup bubble/popover, including More and the agent switcher themselves where necessary.
- Keep small, consistent left, right, and bottom margins, in addition to safe-area clearance. The bottom margin must remain visible above the bottom safe-area inset.
- Slide in from the top; entrance direction does not require top anchoring. Respect reduced motion.
- Match the More-menu/agent-switcher surface styling, preserve interaction and accessibility, handle narrow widths, landscape, tall content and the software keyboard, and leave desktop and native pickers unchanged.
- Inventory all mobile popup surfaces and add representative regression coverage for each category, all-corner rounding, three-side margins, safe areas, overflow, motion and unchanged desktop behavior.

Design specification to include in the implementation:

# Mobile popup presentation

Implementation tracking: FT123 on the factory board. This specification supersedes the earlier top-corners-only requirement.

## Scope

All app-controlled mobile popup menus, dialogs, and popup bubbles/popovers must follow the design and style of the bottom navigation More menu and mobile agent switcher. This includes menus presented as dropdowns on desktop. Native browser and operating-system pickers remain native. Desktop presentation remains unchanged.

## Appearance and motion

- Round all four corners, not only the top-left and top-right corners.
- Keep small, consistent margins on the left, right, and bottom. Preserve these visible gaps in addition to applicable safe-area clearance.
- Match the reference surfaces, borders, shadows, spacing, and backdrop treatment. Bring More and the agent switcher into compliance too if necessary.
- Slide in from the top. This specifies the entrance direction, not a requirement to anchor every popup at the top of the screen.
- Respect reduced-motion preferences while preserving the final layout.

## Safe areas and scrolling

Respect applicable safe-area insets on all sides, including notches, rounded screen corners, and the home indicator. Keep the bottom margin above the bottom safe-area inset; preserve bottom-navigation clearance where appropriate.

Keep controls reachable on narrow phones, in landscape, and when the software keyboard opens. Constrain tall content to the available viewport and provide internal scrolling without horizontal overflow or clipped actions. Maintain readable text and usable touch targets.

## Interaction and accessibility

Preserve selection, confirmation, cancellation, appropriate outside-click dismissal, and Escape handling. Maintain accessible names and roles, focus restoration, and modal focus containment where applicable.

## Verification

Inventory menus, dialogs, and popovers across mobile pages. Check representative cases from every category, including More and the agent switcher, for consistent rounding on all four corners, left/right/bottom margins, entrance direction, safe-area spacing, scrolling, dismissal, and focus behavior. Verify narrow phones, landscape, software keyboards, reduced motion, and unchanged desktop presentation.

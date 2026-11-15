# Mobile popup presentation

Status: design requirement; implementation tracked by FT123.

## Scope

On mobile, every app-controlled popup must use the same presentation language as
bottom navigation's More menu and the mobile agent switcher. This includes popup
menus that appear as dropdowns on desktop, dialogs, and popup bubbles/popovers.
Native browser or operating-system pickers remain native. Desktop presentation
is unchanged.

## Appearance and motion

- Use the More menu and agent switcher as the visual references, not desktop dropdowns.
- Round the top-left and top-right corners consistently with those references.
- Keep small, consistent left and right margins; do not touch the viewport edges.
- Slide in **from the top**. This specifies the entrance direction, not a new
  top-of-screen anchor: preserve the appropriate reference placement.
- Match reference surface, border, shadow, spacing, and backdrop treatment.
- Respect reduced-motion preferences without changing the final layout.

## Viewport and interaction

- Respect all applicable safe-area insets, including notches, rounded device
  corners, the home indicator, and bottom-navigation clearance.
- Keep the whole popup and its controls reachable at narrow widths, in landscape,
  and when the software keyboard opens. Constrain tall content to the available
  viewport and scroll inside the popup rather than clipping actions.
- Preserve each popup's purpose and behavior: selection, cancellation,
  confirmation, outside-click dismissal where appropriate, Escape, and focus
  restoration. Keep dialog semantics and modal focus containment where applicable.
- Maintain readable text and accessible touch targets. Do not shrink controls
  merely to fit the shared shape.

## Verification

Inventory app-controlled menus, dialogs, and popovers across mobile pages. Check
representatives of every category, including More and the agent switcher, on a
narrow phone, landscape, safe-area devices, and with an open keyboard. Confirm
consistent corners, margins, entrance direction, scroll behavior, and dismissal;
verify desktop layouts and reduced-motion behavior do not regress.

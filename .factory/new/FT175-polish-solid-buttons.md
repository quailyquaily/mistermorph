# Polish the solid buttons: primary, danger and highlight

## factory · 2026-11-23 15:18
Owner request:
> the solid buttons like primary, danger, and hlight, need add some design details to make them polished, refined and elegant

### Where they are
The filled variants of the Console's `Button` (`web/console-nsh/components/ui.tsx`, `BUTTON_VARIANTS`: `primary`, `danger`, `highlight`), and the filled round buttons that share their fills (`CircleButton`'s `primary` and `danger`; the capsule toolbar's primary and danger buttons in `components/shared/CapsuleBar.tsx`; the composer's send button when it is ready). Their colours are the theme's (`theme.json`: `primary`, `primary-hover`, `primary-line`, `danger`, `warn` and their disabled tokens), in the light and the dark palette.

### Expected behavior
- The three solid buttons read as made, not as flat coloured boxes: the craft details a filled control carries, each small and quiet. What those are is the build's to find by looking; the usual ones are a hairline a shade deeper than the fill so the edge is crisp on any ground, a faint inner highlight at the top edge, a soft shadow that says the button is raised and deepens on hover, a pressed state that settles (the shadow goes, the fill deepens a step), and a focus ring that follows the corners.
- One language for all three: the same details in the primary, the danger and the highlight colour, so they are one family. The round filled buttons and the capsule's filled buttons take the same treatment where it applies, or the reason is stated.
- Every state keeps working and stays distinct: rest, hover, focus, pressed, selected, disabled (still clearly not pressable, with its own paler colours) and loading (the busy beam still reads on the fill).
- Light and dark each get values that suit them (a highlight or a shadow tuned for one palette is wrong on the other); text on the fill keeps its contrast (4.5:1 at least, as the theme's tests check).
- Motion is the compositor's: only `opacity` and `transform` animate, colours ease as they do now, and reduced motion zeroes the durations.
- Restyle what is there. No new elements, no gradients loud enough to notice as gradients, no glow.

### Decisions left to the build
The request names the feeling, not the details. Look at the three buttons as they are (every size, text and icon, light and dark, at 1x and 2x), list what is flat or uneven, and choose the details; record what was found and what each change is for. Whether the outlined and plain buttons need a matching touch so the family stays coherent is open: change them only where a solid button's new detail makes them look unfinished beside it.

### Acceptance checks
- Each solid variant in every state and size, text and icon, light and dark, in the UI component gallery (`/ui-components`, the `Button`, `CircleButton` and capsule demos).
- Hairlines land on device pixels at 1x, 1.5x and 2x; nothing is clipped by a parent's corners; the focus ring is whole.
- The theme's contrast checks still pass; existing button tests updated for the new looks, with coverage of the pressed and disabled looks. Run `nsh check` and `web/console-nsh/scripts/test.sh`.
- Look at the result in the running Console on real pages (a dialog's confirm, the Jobs composer's Add, a delete confirmation); record any visual check that could not be made.

Scope: the filled button looks and the tokens they need; no change to button sizes, labels or where buttons are used. The outlined danger button is a separate item.

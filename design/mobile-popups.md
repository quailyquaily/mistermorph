# Mobile popup presentation

Implementation tracking: FT123 on the factory board. This specification supersedes the earlier
top-corners-only requirement.

## Scope

All app-controlled mobile popup menus, dialogs, and popup bubbles/popovers must follow the design
and style of the bottom navigation More menu and mobile agent switcher. This includes menus
presented as dropdowns on desktop. Native browser and operating-system pickers remain native.
Desktop presentation remains unchanged.

## Appearance and motion

- Round all four corners, not only the top-left and top-right corners.
- Keep small, consistent margins on the left, right, and bottom. Preserve these visible gaps in
  addition to applicable safe-area clearance.
- Match the reference surfaces, borders, shadows, spacing, and backdrop treatment. Bring More and
  the agent switcher into compliance too if necessary.
- Slide in from the top. This specifies the entrance direction, not a requirement to anchor every
  popup at the top of the screen.
- Respect reduced-motion preferences while preserving the final layout.

## Safe areas and scrolling

Respect applicable safe-area insets on all sides, including notches, rounded screen corners, and
the home indicator. Keep the bottom margin above the bottom safe-area inset; preserve
bottom-navigation clearance where appropriate.

Keep controls reachable on narrow phones, in landscape, and when the software keyboard opens.
Constrain tall content to the available viewport and provide internal scrolling without horizontal
overflow or clipped actions. Maintain readable text and usable touch targets.

## Interaction and accessibility

Preserve selection, confirmation, cancellation, appropriate outside-click dismissal, and Escape
handling. Maintain accessible names and roles, focus restoration, and modal focus containment
where applicable.

## Verification

Inventory menus, dialogs, and popovers across mobile pages. Check representative cases from every
category, including More and the agent switcher, for consistent rounding on all four corners,
left/right/bottom margins, entrance direction, safe-area spacing, scrolling, dismissal, and focus
behavior. Verify narrow phones, landscape, software keyboards, reduced motion, and unchanged
desktop presentation.

## Implementation (Console, `web/console-nsh`)

### The shared paper

One floating paper serves every popup on phones. Its numbers are pure functions in
`lib/mobilePopup.ts`; the tests check them directly.

| Property | Value | Where |
|---|---|---|
| Corners | 16pt on all four (`POPUP_RADIUS`) | `components/ui.tsx` |
| Gap at the left, right and bottom | 12pt (`POPUP_GAP`, the bottom bar's side margin) | `lib/mobilePopup.ts` |
| Widest | 560pt (`POPUP_MAX_WIDTH`), centred in a wider window; a dialog keeps its own width class | `lib/mobilePopup.ts` |
| Surface | `bg-dialog`, a `border-line-faint` hairline, the menus' soft shadow (none on Android, where it would not follow the corners) | `DialogLayer`, `MobileBottomNav` |
| Backdrop | `bg-scrim`, fading with the paper; a press on it closes | `DialogLayer`, `MobileBottomNav` |
| Title row | A square mark and the name in spaced mono capitals over a hairline (`PopupTitle`), where the popup has a name | `components/ui.tsx` |
| Rows | The agent switcher's rows (`PickerList`): rounded, 44pt tall for a finger | `components/shared/PickerList.tsx` |
| Entrance | Slides down from out of sight above the window's top edge to its place in 280ms; leaves the same way in 200ms. Only the translation is negative: the paper is never below its place | `mobilePopupEntrance` |
| Reduced motion | In place at once, gone at once; the same final frame | `motionMs` |

The layer that holds the paper takes each inset once, as its padding, and adds the gap to it: the
status bar or notch at the top, a notch or the navigation bar at a side (landscape), and at the
bottom the navigation bar, gesture handle or home indicator, or the software keyboard's height in
its place (the keyboard covers that bar; the two are never added). The paper pads nothing for the
system, so its own bottom edge, corners included, shows above the inset. Its height is whatever
the padded layer leaves (never less than 120pt); taller content scrolls inside it, with a dialog's
title bar and actions staying in place.

### When it applies

- **Phones** (`mobilePopups()`): a window narrower than 720pt on any platform (a phone upright, a
  narrow browser window), or a touch screen up to the phone layout's 980pt (a phone on its side).
  Dialogs, menus, selects, date pickers and picker bubbles all take the paper.
- **Other touch screens** (`popupSheets()`, a tablet): dropdowns (menus, selects, date pickers)
  take the paper too, at its widest and centred, because nsh/base cannot anchor them to their
  trigger there and would draw a sheet flush with the bottom edge; so do the composer's add menu
  and model picker, which were such sheets. Dialogs and the sidebar's agent bubble keep the
  desktop presentation.
- **Desktops**, including a pointer-driven window between 720pt and 980pt: unchanged. Dropdowns
  open at their trigger, bubbles keep their tail, dialogs are centred and settle in with a fade
  and a scale.

### Inventory

| Category | Popups | Component | On phones |
|---|---|---|---|
| Navigation | More, the agent switcher | `components/frame/MobileBottomNav.tsx` | The reference. Own layer inside the page so the bottom bar stays usable; floats 12pt above the bar; 62% of the page at most. Brought into compliance: slides in from the top (was from the bottom), keeps the gap inside side insets, 560pt at most |
| Menus of commands | Topic rows, skills, contacts, settings rows, every `DropdownMenu` | `DropdownMenu` (`components/ui.tsx`) | `PopupList`: the commands as rows (icon, danger tone, check mark, second line, separators as hairlines) |
| Selects | `SelectField` (plain and searchable), settings lists (`SettingMenu`, behind `SettingSelect` and the unit pickers), TODO pickers (`TodoSelect`) | `components/ui.tsx`, `components/settings/SettingFields.tsx`, `components/todo/TodoSelect.tsx` | `PopupList`; a searchable one gets the filter field, which takes the focus only when pressed |
| Date pickers | TODO "Run at" (date and time), the memories journal's "Since" (clears) | `components/shared/DateField.tsx` | `PopupSheet` holding the calendar, the time field and a Clear button |
| Picker bubbles | The composer's add menu and model picker, the sidebar agent switcher | `components/shared/PopoverPicker.tsx` | `PopupList` with the same rows, filter and footer; no tail |
| Dialogs | `Modal`, `MessageDialog` (and `confirm`), `SettingDialog` and the dialogs built on them (auth, setup pickers, raw JSON, workspace folder, poke, rename, server address) | `DialogLayer` (`components/ui.tsx`) | The paper, at the dialog's own width; two footer actions share the row |
| Action sheets | The composer's Gallery / File choice | `components/chat/AttachSourceSheet.tsx` | The paper (was a sheet with round top corners only) |

Not popups, and left as they are: tooltips; the notice stack; the composer's slash and mention
suggestions (a list inside the composer's own frame); the TODO calendar's "more" bubble (wide
layout only); panels docked at a side of the screen (the chat's topic and workspace panel, the
skill store's detail, `SidePane`), which are persistent panels with their own edge; and the
phone's Progress workbench. Native pickers stay native: the system's photo and document pickers
behind Gallery / File, the browser's file dialog, the system's notification and microphone
permission prompts.

### Interaction and accessibility

Every paper outside the bottom navigation is `DialogLayer`'s: a modal layer that keeps the focus
inside it and gives it back to what had it, closes on Escape, Android's Back and a press on the
backdrop, and is named by its title for screen readers. A dropdown's trigger is still the base
component's (its press, Enter/Space and accessible name are unchanged); only its list moves to the
paper. A menu's commands are `menuitem`s in a `menu`, a select's or picker's choices `option`s in a
`listbox`, named by the popup; a disabled command is inert. Up, Down
and Enter move through the rows and pick one, as in the agent switcher. Opening a popup from the
composer lowers the software keyboard and gives the field its focus back on close.

### Checks

`tests/mobile-popup.test.tsx` covers a representative of each category on an Android phone, an
iPhone, a narrow browser window, a 320pt phone and a phone on its side: the gaps and insets, tall
content, the keyboard, the entrance direction, reduced motion, choosing and cancelling, and the
unchanged desktop presentation at 1280pt and 800pt. `tests/mobile-bottom-nav.test.tsx` covers More
and the agent switcher, `tests/dialog-sheet.test.tsx` the dialogs' motion and actions. Headless
tests cannot read a view's corner radius back: the four corners are one `borderRadius` on the
paper, and what the tests prove is that the paper's bottom edge ends above the inset.

# Corners: one continuous scale

The Console's controls and surfaces have continuous corners: the curvature eases into the edges
instead of meeting them at a quarter circle, as on iOS. They are drawn with nsh's own
`borderCurve: "continuous"` (the `corner-squircle` utility), never with masks, SVG clips or CSS of
the Console's own.

## The scale

| Role | Radius | Class (`components/corners.ts`) | Where |
| --- | --- | --- | --- |
| Controls | 8pt | `CONTROL_CORNERS` | buttons (not round ones), text fields, textareas, select triggers, icon squares, the Fab, field-like triggers (`EnvManagedField`, the `InferenceProviderPicker` trigger), calendar days in date popovers (`CALENDAR_DAY_CLASS`), question options (`QUESTION_OPTION_CLASS`), the Markdown editor's picker rows (`PICKER_ROW_CLASS`) |
| Cards | 12pt | `CARD_CORNERS` | `Card`, `Section` card and boxed, settings and knowledge boxes, question and elevation cards, the secret picker's and the provider picker's cards |
| Popovers | 12pt | `POPOVER_CORNERS` | menus (`MENU_POPUP`), select lists, `PopoverPicker`, the calendar and date popovers, tag suggestions |
| Dialogs | 18pt | `DIALOG_CORNERS`, `POPUP_RADIUS` | `DialogLayer` panels (`Modal`, `MessageDialog`), the phone's floating paper (`PopupSheet`, More, the agent sheet), the Contacts panel |
| Switch tracks | 6pt | `TRACK_CORNERS` (`SWITCH_TRACK_CORNERS`) | every switch |

The radii are theme tokens (`theme.json`, `cssVars.theme.radius-control`, `radius-card`,
`radius-popover`, `radius-dialog`, `radius-track`), which the classes name, and `RADIUS` in
`components/corners.ts`, for what is computed from a radius when the modules load (before the theme
can be read). `tests/corners.test.tsx` keeps the two equal. The generic `--radius` (2pt) stays for
small marks, tags, skeletons and tooltips, which are outside the scale, and for image tiles such as
a provider's logo.

## Rules

1. **Circles stay circles.** Round buttons (`CircleButton`, `circleButtonClass`), avatars, status
   dots, pills and the composer keep `rounded-full` or their own pill radius. A continuous corner
   with no room for its curve is drawn circular by every nsh backend, so nothing round changes.
2. **Nested corners are derived, not chosen.** A box inside another, near its corner, takes the
   outer radius less the inset between them (the outer box's border and padding):
   `nestedRadius(outer, inset)`.
   - A menu item (`MENU_ITEM_BOX`): its highlight is inset 8pt from the menu's sides as from its top
     and bottom, so 12 − (1 + 8) = 3pt; its text is 8pt further in, 16pt from the hairline as before.
   - A settings select's item and a tag suggestion (lists with 4pt of padding): 12 − 5 = 7pt.
   - Rows on the phone's floating paper (`POPUP_ROW_RADIUS`, `PickerList`'s default): 18 − 9 = 9pt;
     in a `PopoverPicker` bubble: 12 − 9 = 3pt.
   - A switch's thumb: the track's 6pt less its hairline and 2pt padding, 3pt.
   - A text field's clear button: 8pt less half the height difference (2, 3 and 4pt at md, sm, xs).
   - The Markdown editor's toolbar buttons and tabs: 8 − 5 = 3pt.
   - A box deeper inside another than the outer radius (a calendar day 13pt in from its 12pt
     bubble) nests in nothing: it takes its own role's radius.
3. **Small controls fit their curve.** The web draws a continuous corner only where about 1.53
   times the radius fits half the shorter side (`cornerReach`); a radius that does not fit is drawn
   circular. The 24pt `xxs` button therefore takes 7pt (`fittingRadius`), not 8, and so does the
   24pt button that clears a date (`DATE_CLEAR_CLASS`). A one-line question option (about 25pt
   tall) and a 32pt calendar day still fit 8pt.
   - The Fab's registration marks (`components/fabMark.ts`, drawn by `Fab` in
     `components/ui.tsx`) are not boxes with two border sides: those were painted side by side,
     each side's half of the turn on its own, and could part at the curve. Each mark is one open
     path stroked on a decorative 23pt canvas (a 1pt muted hairline, its outer edge 5pt outside
     the button's top-left or bottom-right corner): a 22pt arm, the continuous curve concentric
     with the button's (8 + 4.5 = 12.5pt to the stroke's centre, so the clear gap stays about 4pt
     round the turn), and the other arm, meeting the curve on its tangents.
4. **Docked panels keep square edges.** Side sheets (`SidePane`, the workspace and skill store
   sheets) and columns attached to a window edge are not rounded.
5. **Only the corners change.** Colors, sizes, padding, text positions, behavior and accessibility
   stay as they were; `tests/corners.test.tsx` measures the controls' frames to hold that.
6. **Fills, borders, focus halos and shadows follow the shape by themselves.** Do not add
   `overflow-hidden` to get there. A box that already clips (a button, a field box, a dialog panel)
   clips its press layer and fills to the same continuous corners; the loading beam
   (`BusyBeam`) is told the button's radius.

## Renderers

Checked on nsh 0.6.0 (5541637):

- **Core** (`nsh-core` 0.6.0): `borderCurve: "continuous"` and `corner-squircle` set the view's
  continuous corners (`style.rs`, `shape.rs`).
- **Web**: `nsh.js` draws them as CSS `corner-shape: superellipse(1.7)` with the radius scaled to
  Core Animation's reach, on the view and its border layer together, so the border, background,
  shadow and clip share the shape. This needs a browser with `corner-shape` (Chromium); Safari and
  Firefox draw circular corners of the same radius. The probe for this change ran Chrome 157 on the
  nsh 0.5.1 web runtime (no 0.6.0 web runtime was installed), which has the same `placeCorners`.
- **Desktop app (GPUI, `nsh-platform-gpui` 0.6.0)**: draws circular corners for
  `borderCurve: "continuous"` (documented in `desktop/nsh/vendor/nsh-platform-gpui/src/decor.rs`).
  The radii change there; the curve does not.
- **Android**: not checked (the nsh 0.6.0 Android runtime is not installed here).

## Checking

- `tests/corners.test.tsx` (fixture `tests/fixtures/corners-app.tsx`): the scale against the
  theme, the classes, the nested radii, round buttons left round, and the controls' sizes and menu
  text positions on a desktop and a phone. The fixture also holds the page and editor surfaces on
  the scale (a variable-managed field, the provider picker, a date filter, a question card), which
  the test still drives: a date picked and cleared, an option answering, a provider chosen. Headless tests cannot read a radius or a curve back.
- `tests/fab-marks.test.tsx` (fixture `tests/fixtures/fab-app.tsx`): the Fab marks' classes and
  radius, and their frames round the button (enabled, disabled, another icon) on a desktop, a
  390pt phone and with reduced motion; the button still presses and names itself.
- By eye: `nsh test --target web` with `app.screenshot`, or the fixture packaged for the web and
  opened in Chrome, where `getComputedStyle(el).cornerShape` reads `superellipse(1.7)` on every
  shaped control. The gallery (`/ui-components`) shows the controls, a long value in a field and
  controls on a card.

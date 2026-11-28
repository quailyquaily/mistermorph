# UI component gallery

A testing page of the Console that shows its colour scheme and lists its reused UI components (the
ones more than one area of the Console uses), for looking at them, pressing them and reading them
in each language and in the built-in light and dark themes, on a desktop window and on a phone.

- **Address:** `/__ui-components` (under the Console's base path, for example
  `http://127.0.0.1:9080/__ui-components`), beside the other underscore testing pages
  (`/__boot-preview`, `/__components`). The former address, `/ui-components`, is now an unknown
  address like any other; it does not redirect.
- **No entry:** nothing in the sidebar, the phone's bottom navigation, its More sheet or any menu
  leads to it. Type the address.
- **Way out:** the page has no navigation, so its head has a Logout button: it logs out and shows
  the login page (see below).
- **Access:** the route is not public. It passes the same guard as every workspace page: a valid
  session (or the login page first, which returns to the gallery), no blocking setup problem, and a
  finished setup. The older public `/__components` address is a different, empty stub and is
  unchanged.
- **Optional start:** `/__ui-components?group=<section id>&q=<text>` opens one section and/or with the
  filter filled in (`group` is one of the ids in `GALLERY_GROUPS`, such as `controls`, `overlays`,
  `motion`, `settings`). The query is read once; the page does not write it back.

## What is on the page

- A head with the theme control (Light or Dark: Aojashin or Midnight, the two palettes the app is
  built with), the language control, the Logout button, a
  filter (by
  component name or file path, and by a colour token's name or value), the count of matching
  components, and the last local action.
- The colour scheme, a section of its own (`Colors` in the index, `?group=colors`; `All` shows
  the components): every token of `theme.json`
  that both palettes have, in sections by what it is for (surfaces, text, primary and accent,
  status, lines and states, charts; `pages/ui-components/colors.ts`). Each is a swatch drawn in the
  token as the app draws it now, with its name and its value in the appearance shown. A key that
  only nsh's own components read (shadcn's names: `background`, `border`, `destructive`, the
  `*-foreground` that equal `foreground`) also names the Console's token of the same colour, which
  the Console's code uses instead. Then the tints: a row per colour (blue, primary, info, ok, warn,
  danger) with its fills and borders at each step a share may take, each step with what it is for
  (`pages/ui-components/colorRules.js`; `scripts/color-steps.test.mjs` holds the sources to both
  rules). The filter shows a colour's row by its name. The
  theme control is the Console's own setting (`themeState.setTheme`), as the language control
  is: the choice is kept on the device.
- A section index: a sidebar beside the page on a window wider than 900pt (a row per section with
  its count, drawn as the Settings page's index is), and a row of chips in the head that scrolls
  sideways on narrower ones. `All` shows every section; a row or a chip shows one. When nothing matches, the page says so and offers one button that
  clears the filter and shows every section again.
- Per section: a card for each listed component (its name, its file, labelled variants).

The cards take one column on a phone, two on a wide window and three on a very wide one; demos
marked `wide` take the whole row. A card never grows past the page: tables and variants whose text
does not wrap scroll sideways inside the card (`Wide` in `pages/ui-components/demo.tsx`), and
one-line titles are cut by the component's own fade or ellipsis.

Only the demos near the visible part of the page are mounted (within 600pt of it; `DemoCard` in
`pages/ui-components/UiComponentsPage.tsx`). Many components draw on every frame while they show a
running state (spinners, beams, clocks), wherever on the page they are, and with all of them
mounted the page was slow to scroll and to type in. A card that is away keeps its head and the
height its demo had, so the page does not move; its demo's local state starts over when it comes
back. A test that presses a demo's control brings its card up first, by filtering for its name.

## Languages

The control lists every language the Console has (`LANGUAGES` in
`components/LanguageSelector.tsx`: English, 中文, 日本語) and calls `localeState.setLanguage`, the
same call the Console's own language menu makes, so the choice is the Console's saved language. The
gallery's own strings are in the one catalog (`lib/i18n/index.js`, keys starting with `uig_`),
including strings with values filled in (`{count}`, `{via}`, `{percent}`) and one/many pairs
(`uig_count_one`, `uig_count_many`). Production components shown in the demos use their own
catalog strings, and the fixtures add fixed mixed-script long text to show wrapping and cutting.

## Inventory

`pages/ui-components/inventory.js` lists the Console's reused UI components, by the file each is
in; the gallery mounts one demo for each (`pages/ui-components/demos/`, by the entry's id).

A component is reused when its file exports it and at least two areas of the Console use it; a
component of the shared kit (`components/shared/`) is reusable by where it is, and is listed once
anything uses it (the capsule navigation of the phone's bottom bar, for one). An
area is a folder of `components/` or `pages/` (`chat`, `todo`, `settings`, `contacts`, …;
`settings-page` counts with `settings`, a file directly in `components/` is `shared`). So the
gallery has the shared kit (`components/ui.tsx`, `components/motion/`, `components/shared/`) and
the parts one feature made that another took up (the chat composer on the Jobs page, the index
column of the knowledge pages, the settings fields the Setup page uses).

Not listed, on purpose:

- a page's own parts and file-private components;
- a part only its own feature uses, however many of that feature's files use it;
- whole pages and the app's frame (`Shell`, `Sidebar`, the page stack): they are bound to the
  router and to live data, and are looked at where they are;
- a reused component that cannot be mounted with stand-in props (it reads live stores or calls the
  Console as soon as it mounts, such as `SecretInput`), or that only ever shows inside another
  one's demo.

`scripts/ui-components-inventory.test.mjs` reads the sources and fails when an entry names a
component that is gone or is not exported, when a listed component is no longer reused, and when
the entries and the demos do not match one to one. It does not ask for every reused component to be
listed: a new component needs no entry, and adding one (with its demo) is a choice.

## What the demos do and do not do

Demos use fixed, synthetic fixtures and local state (`pages/ui-components/demo.tsx`,
`pages/ui-components/demos/`). Every callback a component would use to send, save, approve,
upload, install or navigate ends in a local note, shown in the head as "Last local action". Opening
the page asks the Console only what the route guard and the app frame ask on any page; the demos
ask nothing. Known limits, stated plainly:

- `KindAvatar` reads the endpoint list to find an agent contact's avatar. The fixture contacts
  have none, so nothing is fetched and the result does not depend on that list.
- Some controls act on the device rather than the Console, as they do in production: copy buttons
  write to the clipboard, links in Markdown and in the sign-in dialogs open an `example.com`
  address, `ImageUploadField` opens the device's file picker, and the notice demo uses the
  Console's real notice stack (in memory only).
- Changing the language here changes the Console's language, as the control is the Console's own.
- Logout is the Console's own logout, the one Settings › General uses (`logOut` in
  `lib/logout.ts`; the gallery does not load the Settings page's state for it): `POST
  /auth/logout`, then, even when that request fails, the session and the kept answers are cleared
  on the device and the login page replaces the gallery in the history, so going back does not show
  the gallery again without logging in. The button is disabled while the logout runs. It is the one
  request the page makes after it has loaded, and only when pressed.

## Buttons: text or a glyph, never both

A Console button shows its label or an icon, not the two side by side.

- `Button` (`components/ui.tsx`) enforces it: given an `icon` it is a square icon button. Its
  `label` is then not drawn; it stays the button's accessible name and is its tooltip (a `title`
  is the tooltip only of a button that has no label). `disabled`, `selected` and `loading` are as
  they were. The busy beam of `loading` is a state, not a glyph: a text button keeps its label
  while it runs.
- The controls that draw their own box follow the same rule: `PlaceholderButton` (the dashed "add"
  row) and the other dashed add buttons show a plus, the path field's Browse part a folder, the
  Logs page's "Load older" a caret, each named by its former label.
- Where the label was a value to read rather than a name, the value is text beside an icon button:
  the release checksum with its copy button, the server's address with its button on the phone's
  login page, and the system and build of a release's download with its download button. The
  Logs page's Follow button is its status mark alone.
- Not buttons, and unchanged: menu rows and menu or select triggers, list and tree rows,
  disclosure rows with a caret, tabs, filter chips, file pills, navigation entries and links.

The `Button` demo shows text buttons and icon buttons apart (variants, sizes, selected, loading);
it has no example with both.

## Tests

- `tests/ui-components.test.tsx`: the direct address and its guard (session, login redirect and
  return, setup), the old `/ui-components` address showing the unknown page, the start parameters,
  Logout (the request, the session and the kept answers cleared, the login page in place of the
  gallery, going back, a failed request, the button busy while it runs, the button inside the head
  at 360pt and 390pt and on a desktop), no navigation entry on desktop or phone, every inventory entry on the page,
  the index, the filter, the empty state and its reset, the three languages changing in place,
  working local controls and overlays, the phone layout, and that no request is made after the
  page has loaded.
- `scripts/ui-components-inventory.test.mjs`: the inventory against the sources
  (`node --test scripts/ui-components-inventory.test.mjs` in `web/console-nsh`).

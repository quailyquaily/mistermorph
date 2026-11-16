# UI component gallery

A testing page of the Console that lists its UI components, for looking at them, pressing them and
reading them in each language, on a desktop window and on a phone.

- **Address:** `/ui-components` (under the Console's base path, for example
  `http://127.0.0.1:9080/ui-components`).
- **No entry:** nothing in the sidebar, the phone's bottom navigation, its More sheet or any menu
  leads to it. Type the address.
- **Access:** the route is not public. It passes the same guard as every workspace page: a valid
  session (or the login page first, which returns to the gallery), no blocking setup problem, and a
  finished setup. The older public `/__components` address is a different, empty stub and is
  unchanged.
- **Optional start:** `/ui-components?group=<section id>&q=<text>` opens one section and/or with the
  filter filled in (`group` is one of the ids in `GALLERY_GROUPS`, such as `controls`, `overlays`,
  `chat`, `settings`). The query is read once; the page does not write it back.

## What is on the page

- A head with the language control, a filter (by component name, file path, or the demo a
  component is shown in), the count of matching components, and the last local action.
- A section index: a sidebar beside the page on a window wider than 900pt (a row per section with
  its count, drawn as the Settings page's index is), and a row of chips in the head that scrolls
  sideways on narrower ones. `All` shows every section; a row or a chip shows one. When nothing matches, the page says so and offers one button that
  clears the filter and shows every section again.
- Per section: a card for each component that has a demo (its name, its file, labelled variants),
  then a list named "No demo of their own" with every other component of that section and the
  reason.

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

`pages/ui-components/inventory.js` lists every component declared in a `.tsx` file under
`components/` and `pages/`, exported or file-private, with how the gallery shows it:

| Mode | Meaning | Count |
| --- | --- | --- |
| `demo` | The production component, mounted with synthetic props | 151 |
| `composed` | Shown inside another component's demo (named by `via`) | 72 |
| `listed` | Not mounted; the page gives the reason | 165 |

`scripts/ui-components-inventory.test.mjs` reads the sources and fails when a component is missing
from the inventory or when an entry names a component that no longer exists, so a new component
must be added to the inventory (and given a demo or a reason) before the tests pass.

### Components that are not mounted, and why

- **Whole pages (16)** — Audit, Chat, Contacts, Context, Login, Logs, Memories, Overview, Repair,
  Settings, Setup, Skills, Skill store, Stats, TODO, and the gallery itself. Each is bound to its
  route and loads its data when mounted. Open them at their own addresses.
- **Private parts of something not mounted (94)** — file-private components of those pages and of
  the live panels below (for example the Setup page's stages, the Stats page's bands, the
  Memories page's rows). They are not exported, so they cannot be mounted apart from their owner.
- **Live components (41)** — they read live stores or call the Console or an agent as soon as they
  mount, and take no stand-in: `InsecureBanner`, `AppMarkdownEditor`, `WorkspaceDirPickerDialog`,
  `ArtifactPreviewCard`, `SkillFileTree`, `CoderQuotaButton`, `DailyUsagePanel`,
  `WeChatLoginPanel`, `XLoginPanel`, `ConsoleEndpointsPanel`, `SecretInput` (asks
  `/secrets/info` when it mounts), `SecretKeyPicker`, `LLMConfigForm` (contains `SecretInput`),
  `SettingsAppPanel`, `SettingsUpdatePanel`, `SettingsCreditsPanel`, `ShortcutsPanel` and
  `TopicNotificationSetting` (both change saved settings), `TodoHeartbeatEditor`, `TodoIndex`,
  `TodoTaskEditor` (all three need the TODO page's state, which loads and saves through the API),
  `FilePreviewDialog`, `TopicRenameDialog`, `TopicSidebar`, `WorkspacePanel` (all need the chat
  controller), `ServerDialog`, `RuntimePanel`, `SettingsDialogs` and the Settings sections and
  panes (all need the Settings store).
- **Frame components (8)** — `Shell`, `Sidebar`, `MobileBottomNav`, `MobileBottomMenus`,
  `PageStack`, `PageView`, `Workbench`, `TodoCalendar`. They follow the router and the selected
  agent, and pressing them navigates away. Their parts that take props are shown instead:
  `NavList`, `NavLink`, `AgentSwitcher`, `AgentPicker`.
- **Nothing to draw (5)** — `BarRoom`, `MobileBarSpacer`, `ComposerMeasure`, `UnderContext`,
  `AgentFavicon`.
- **Needs a picked file (1)** — `ImageAdjustDialog`; `ImageUploadField`, which opens it, is shown.

Non-visual modules (stores, helpers, hooks such as the pane stack and the sliding selection) are
not components and are not listed.

## What the demos do and do not do

Demos use fixed, synthetic fixtures and local state (`pages/ui-components/demo.tsx`,
`pages/ui-components/demos/`). Every callback a component would use to send, save, approve,
upload, install or navigate ends in a local note, shown in the head as "Last local action". Opening
the page asks the Console only what the route guard and the app frame ask on any page; the demos
ask nothing. Known limits, stated plainly:

- The chat fixtures are shaped by the chat's own pure normalizers
  (`lib/core/chat-task-history.js`, `lib/core/chat-approvals.js`); `ReceivedFile` gets a stand-in
  file store that fetches and downloads nothing.
- `KindAvatar` and `ContactCard` read the endpoint list to find an agent contact's avatar. The
  fixture contacts have none, so nothing is fetched and the result does not depend on that list.
- `NavList` and `NavLink` mark the row whose address is the current one; the fixture gives its
  first row the gallery's own address so one row is active.
- Some controls act on the device rather than the Console, as they do in production: copy buttons
  write to the clipboard, links in Markdown and in the sign-in dialogs open an `example.com`
  address, `ImageUploadField` opens the device's file picker, and the notice demo uses the
  Console's real notice stack (in memory only).
- The elevation card counts down to a deadline, so its open example is dated one hour after the
  page mounts; a message's relative labels follow the device's clock and time zone.
- `RunMarker` is given an empty layout probe, because it spreads the probe it is given and the
  web runtime cannot spread a missing one.
- Changing the language here changes the Console's language, as the control is the Console's own.

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
  return, setup), no navigation entry on desktop or phone, every inventory entry on the page,
  the index, the filter, the empty state and its reset, the three languages changing in place,
  working local controls and overlays, the phone layout's sheets, and that no request is made
  after the page has loaded.
- `scripts/ui-components-inventory.test.mjs`: the inventory against the sources
  (`node --test scripts/ui-components-inventory.test.mjs` in `web/console-nsh`).

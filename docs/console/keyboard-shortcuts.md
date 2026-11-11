# Keyboard shortcuts

The Console (web, desktop app, and the Android app with a hardware keyboard)
has keyboard shortcuts for a few of its actions. They are listed, and can be
changed, in **Settings → Keyboard shortcuts**; **Show keyboard shortcuts**
(`Shift+/`, that is `?`) opens that list from any page. The tooltips of the
New Topic button, the sidebar's pages and the sidebar's edge show the keys in
effect.

These are application shortcuts: they work while the Console has the keyboard
focus. There are no system-wide hotkeys.

## Actions and default keys

`Mod` is Command (⌘) on a Mac and Control elsewhere, in a browser as in the
desktop app. Labels follow the platform: `⇧⌘O` on a Mac, `Ctrl+Shift+O`
elsewhere.

| Action | Browser | Desktop app | Works |
| --- | --- | --- | --- |
| New topic | `Mod+Shift+O` | `Mod+N` | on the Chat page |
| Search topics | `Mod+K` | `Mod+K` | on the Chat page, while the topic list shows |
| Go to the message field | `Mod+I` | `Mod+I` | on the Chat page, while a conversation shows |
| Go to Topics | `Alt+Shift+1` | `Mod+1` | on every page |
| Go to Contacts | `Alt+Shift+2` | `Mod+2` | on every page |
| Go to TODO | `Alt+Shift+3` | `Mod+3` | on every page |
| Go to Memories | `Alt+Shift+4` | `Mod+4` | on every page |
| Go to Skills | `Alt+Shift+5` | `Mod+5` | on every page |
| Go to Usage | `Alt+Shift+6` | `Mod+6` | on every page |
| Go to Audit | `Alt+Shift+7` | `Mod+7` | on every page |
| Go to Settings | `Alt+Shift+,` | `Mod+,` | on every page |
| Fold or unfold the sidebar | `Mod+\` | `Mod+\` | on wide windows, where the sidebar shows |
| Show keyboard shortcuts | `Shift+/` | `Shift+/` | on every page |

"Every page" means the agent's pages: not the login, setup or troubleshooting
pages. The Android app uses the desktop app's defaults.

The browser's defaults differ because browsers never pass `Mod+N`, `Mod+T`,
`Mod+W` or `Mod` with a digit to a page (they open windows and switch tabs).
No default replaces a browser feature people rely on (the address bar, find,
print, reload, zoom, back and forward, ...), and none uses a key the text
editor of Memories, Skills and TODO uses.

## When a shortcut acts

- Once per press: holding the keys down does not repeat it.
- Only where its action is: `Mod+K` searches topics on the Chat page and does
  what the browser does with it elsewhere.
- Not while a dialog, a menu, a list of choices or the composer's suggestions
  are open (they own the keyboard), and not while Settings records new keys.
- In a text field, keys with Control or Command act (except the editing ones);
  keys without them type. So `Shift+/` types `?` in the message field, and in
  the browser the `Alt+Shift` page keys act only outside a text field (they
  type characters on some keyboards).
- A text editor (Memories, Skills, TODO) keeps its own keys while it has the
  focus (`Mod+L`, `Mod+/`, `Mod+D`, ...).
- In a browser, keys an input method (IME) is composing never act.

## Changing the keys

Each row of the list shows the action, its keys and whether they are the
default, changed, or removed:

- **Change** records new keys: press them, or Escape to cancel (Cancel does
  the same). Tab is left to move the focus, so it cannot be recorded.
- **Remove** leaves the action without a shortcut. This is saved as such: a
  removed shortcut stays removed, it does not come back as the default.
- **Reset** gives the action its default keys back.
- **Restore all defaults** (after a confirmation) resets every action.

Changes are saved at once.

Keys that cannot be used are refused with the reason, and recording goes on:

- Tab, Enter, Space, Escape, the arrows, Home, End, Page Up and Down,
  Backspace and Delete, alone or with Shift: the Console uses them to move,
  press, scroll and edit.
- `Mod+A`, `Mod+C`, `Mod+V`, `Mod+X`, `Mod+Z`, `Mod+Y`, `Mod+Shift+Z`:
  editing.
- What the system keeps: `⌘Q`, `⌘H`, `⌥⌘H`, `⌘M`, `⌃⌘F`, `⌘Tab`, `⌘Space`,
  `` ⌘` `` on a Mac; `Ctrl+Q`, `Alt+F4`, `F11`, `Alt+Tab`, `Ctrl+Alt+Delete`
  elsewhere, where the Windows (Super) key is not recorded either.
- In a browser: `Mod+N`, `Mod+T`, `Mod+W` (with or without Shift),
  `Ctrl+Tab`, `Ctrl+Page Up/Down`, `Mod+1` to `Mod+9`, and `Shift+Escape`
  (Windows and Linux) or `⌘⇧[`, `⌘⇧]`, `⌥⌘←`, `⌥⌘→` (Mac). Keys the browser
  or the system takes for itself never reach the Console, so pressing them
  while recording does nothing.

Keys that work but replace something are accepted with a note in the row:

- In a browser, keys of a well-known browser feature (`Mod+L`, `Mod+F`,
  `Mod+P`, `Mod+S`, `Mod+R`, `F5`, `Mod+D`, `Mod+J`, zoom, back and forward,
  the developer tools, ...): while the Console has the focus, the shortcut
  acts instead.
- Keys the text editor uses: the editor keeps them while it has the focus.
- Keys without Control or Command: they act only while no text field has the
  focus.

Keys another action already has are not taken from it silently. The row says
which action has them and offers **Reassign**, which moves the keys and leaves
the other action without a shortcut, or **Cancel**. Restoring a default that
another action has now is refused the same way; change or remove that action
first.

## Where they are saved

The changes are saved with the Console's other local values (the browser's
`localStorage`; a file of the desktop app), not in `config.yaml`, under one
key per environment: `mistermorph.shortcuts.web` in a browser and
`mistermorph.shortcuts.desktop` in the apps. Changing the desktop app's keys
never changes the browser's, and the reverse.

The value is `{"version": 1, "bindings": {"<action>": "<keys>"}}`, with `""`
for a removed shortcut. Actions without an entry use the default. A value that
cannot be read (not JSON, an unknown action, keys that cannot be used there)
is ignored for that action, which keeps its default; the rest still applies.
If two actions end up with the same keys (saved elsewhere, or a later default),
a changed one wins over a default and otherwise the first in the list above;
the other is shown as not active. A change saved in another window or tab
applies at once.

Action identifiers: `chat.newTopic`, `chat.searchTopics`,
`chat.focusComposer`, `nav.chat`, `nav.contacts`, `nav.todo`, `nav.memories`,
`nav.skills`, `nav.stats`, `nav.audit`, `nav.settings`,
`frame.toggleSidebar`, `help.shortcuts`.

## For developers

- `web/console-nsh/lib/shortcuts.ts`: the actions and their defaults, the
  checks, the saved changes.
- `web/console-nsh/components/frame/shortcutDispatch.ts`: binds each action's
  keys once through nsh's `keymap`, which keeps text fields' typing keys,
  ignores keys being composed, and does not repeat on held keys. A page says
  what an action does with `provideShortcut(id, run, available)`.
- `web/console-nsh/components/settings/ShortcutsPanel.tsx`: the Settings list.
- Tests: `web/console-nsh/tests/keyboard-shortcuts-model.test.tsx` and
  `keyboard-shortcuts.test.tsx`.

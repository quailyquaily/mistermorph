# Keyboard shortcuts

The Console has keyboard shortcuts for a few of its actions, where a keyboard
is expected (see [Where shortcuts are on](#where-shortcuts-are-on)): a browser
window in the desktop layout, the desktop app, and the Android app with a
hardware keyboard connected. They are listed, and can be changed, in
**Settings → Keyboard shortcuts**; **Show keyboard shortcuts** (`Shift+/`,
that is `?`) opens that list from any page. The tooltips of the New Topic
button, the sidebar's pages and the sidebar's edge show the keys in effect.

These are application shortcuts: they work while the Console has the keyboard
focus. There are no system-wide hotkeys.

## Where shortcuts are on

One decision (`web/console-nsh/lib/shortcutPolicy.ts`) turns the application
shortcuts on or off as a whole: the keys that act, the hints that name them
and the Keyboard shortcuts section of Settings. A shortcut that is not shown
never acts.

| Where the Console runs | Shortcuts |
| --- | --- |
| Browser, desktop layout (window wider than 980 pt) | on |
| Browser, phone layout (980 pt or narrower) | off, also with a hardware keyboard |
| Desktop app | on, at any window width |
| Android app, hardware keyboard connected | on, at a phone's width and a tablet's |
| Android app, no hardware keyboard, or unknown | off |
| iOS app | off (nothing reports its keyboard, see below) |

While they are off:

- no application shortcut acts, and none takes a key: every key goes to the
  focused field, the page, the browser and the system as if the Console had
  no shortcuts;
- tooltips and the Send button's name show no keys;
- Settings has no Keyboard shortcuts section, and its address
  (`/settings/shortcuts`) opens Settings without it (the list of sections on
  a phone).

The saved keys are kept and apply again when the shortcuts come back on.

The decision follows the window and the keyboard without a reload. Making a
browser window narrower than the breakpoint turns the shortcuts off and
closes the Keyboard shortcuts section if it is open (a recording under way
ends without saving); making it wide turns them back on. In the Android app
the same happens when a keyboard is connected or taken away, and the state is
asked again each time the app comes back to the front.

### What counts as an application shortcut

A key the Console itself gives to an action of the app or of a page:

- the actions in the table below;
- in the chat: Enter to send (Shift+Enter is a new line), Up and Down through
  the messages sent before, Escape to leave an edit, and the number keys of a
  question's choices;
- Escape closing a panel beside the content (an activity's details, a
  channel's settings, a skill in the store).

Where shortcuts are off, Enter in the message field is a new line and the
Send button sends; Up and Down move the caret; panels close with their own
close or back button.

Keys that operate the control that has the focus, or a popup that is open,
are not application shortcuts and work everywhere: typing and editing, the
input method, Tab, Enter or Space on a focused button, Escape and the arrows
in a dialog, menu, list of choices or the composer's suggestions (Enter or
Tab picks a suggestion), Escape clearing a search field, the arrows on a
focused splitter or number field, Escape dropping a dragged topic. So do the
system's and the browser's own shortcuts and assistive technology.

### How a keyboard is detected, and what is not

- **Browser.** A page cannot ask whether a hardware keyboard is connected,
  and the Console does not guess: not from keys that arrive, not from an
  on-screen keyboard that stays hidden. Only the layout decides. A phone or
  small tablet browser with a Bluetooth keyboard therefore has no shortcuts,
  by design; a tablet browser wide enough for the desktop layout has them
  whether or not a keyboard is attached, like any desktop-layout window.
- **Desktop app.** Always on; nothing is detected.
- **Android app.** The app's native part
  (`web/console-nsh/android/src/com/mistermorph/console/HardwareKeyboard.java`,
  `AndroidHardwareKeyboard.java`) answers the host call `morph.keyboard.state`
  with `{"physical": "connected" | "disconnected" | "unknown"}` and sends
  `morph.keyboard.changed` with the same data. "Connected" means Android's
  `InputManager` lists an enabled, non-virtual input device that is a keyboard
  source with an alphabetic layout (built in, USB, Bluetooth or a cover), and
  the configuration does not report the hardware keyboard as hidden (a closed
  slider, a cover folded back). It listens to input devices being added,
  removed or changed and to configuration changes, and reads again when the
  activity resumes; the Console also asks again when the app comes back to the
  front. If `InputManager` is missing or throws, the answer is "unknown".
  The Console takes only an explicit "connected" as a keyboard: "unknown", an
  answer of another shape, a failed call, and an APK built without the native
  part (plain `nsh package`) all leave the shortcuts off. While a refresh
  after resume is pending, the last known state holds.
- **iOS app.** The repository has no iOS native part (the build is nsh's
  alone), so nothing answers `morph.keyboard.state`: the state is unknown and
  shortcuts stay off, also with a hardware keyboard. Turning them on needs a
  native part that answers the same two messages (for example from
  `GCKeyboard.coalescedKeyboard` and its connect and disconnect
  notifications).

Known limits of the Android detection: it trusts what devices report, so an
accessory that wrongly presents itself as a full alphabetic keyboard (some
barcode scanners and remote controls do) turns shortcuts on, and a keyboard
that reports a non-alphabetic type does not. Android does not say whether
the user actually types on a connected keyboard.

What was verified: the decision and its effects are covered by the Console's
headless tests, which play the host's answers and events
(`tests/shortcut-eligibility.test.tsx`), and the Android decision by a JVM
test (`HardwareKeyboardTest`); the Android classes compile against the
Android SDK. No Android or iOS device or emulator, and no real keyboard being
connected or disconnected, was part of that testing.

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
pages. The Android app uses the desktop app's defaults. All of this holds
where shortcuts are on (above).

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

- `web/console-nsh/lib/shortcutPolicy.ts`: where application shortcuts are on
  (`shortcutsEligible()`, read reactively). Every application shortcut, hint
  and the Settings section goes through it: a new key bound to an action of a
  page or the app must check it too.
- `web/console-nsh/lib/mobileHost.ts`: the phone app's hardware keyboard
  state from its native part (`morph.keyboard.state`,
  `morph.keyboard.changed`).
- `web/console-nsh/lib/shortcuts.ts`: the actions and their defaults, the
  checks, the saved changes.
- `web/console-nsh/components/frame/shortcutDispatch.ts`: binds each action's
  keys once through nsh's `keymap`, which keeps text fields' typing keys,
  ignores keys being composed, and does not repeat on held keys. A page says
  what an action does with `provideShortcut(id, run, available)`.
- `web/console-nsh/components/settings/ShortcutsPanel.tsx`: the Settings list.
- Tests: `web/console-nsh/tests/keyboard-shortcuts-model.test.tsx`,
  `keyboard-shortcuts.test.tsx` and `shortcut-eligibility.test.tsx`; the
  Android decision in `web/console-nsh/android/test/.../HardwareKeyboardTest.java`
  (`scripts/android-host.sh test`).

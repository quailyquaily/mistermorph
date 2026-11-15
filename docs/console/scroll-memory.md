# Remembered scroll positions

Switching pages in the navigation (the sidebar, a phone's bottom bar) and coming back finds a
page's list (column 2) and what is open beside it (column 3) scrolled where they were left
(FT121). `web/console-nsh/lib/scrollMemory.ts` keeps the places; this note records the rules, where
it is wired, and what was checked.

## Rules

- **Memory only.** The places live in a `Map` of the module: never in `localStorage`,
  `sessionStorage`, a database or on the server. A reload, or the app started again, begins with
  nothing remembered.
- **An area** is one scroller of a page: the page instance (its kind and, for an agent's pages, the
  agent: `pageInstanceKey`, as the page host keys its pages), the column, and a name. Areas, pages
  and agents are independent. An area never scrolled, or left at its top, has no entry and starts
  at the top.
- **Column 3 belongs to column 2's current item.** Its areas are saved with that item's identity
  (`selection`). The same item on the way back restores them. Any other item, or none, forgets the
  place and puts the column at its top, in the page or by the time it is back; only the last
  item's place is ever kept, never one per item. A page that finds its item after it opens (the
  identity is `""` at first) has the place wait for it.
- **The Contacts library has two tabs**, people and agents, and the page opens on people each
  time: the library's place is saved with its tab (as a `selection`). The other tab, in the page
  or on the way back, starts at the top and the old place is forgotten.
- **Restoring** applies the offset without animation when the scroller is made, and again on a
  short schedule (about five seconds in all) while the content does not reach it yet: a scroller
  clamps an offset past its content's end, and a `Scroll` reports its content's size only as it
  scrolls. `ready` holds the restore back while a load is in flight. Until the place is reached,
  or the schedule ends, what is remembered stays as it was; then the place the scroller could
  reach is kept. The reader scrolling in the meantime ends the restore.
- **What is not the reader's scroll is not saved:** a scroller pulled back because its content no
  longer reaches its offset (rows going as the page leaves, a list emptied by a reload), and
  anything a page reports while it slides out.
- **The conversation** (`ChatHistoryList`) keeps its own rules. At the newest message nothing is
  remembered: it opens at its end and follows it, as before. Scrolled up, the place is the message
  at the top of the view and the offset into it (`measureScrollPosition` /
  `scrollToIndex`), since the rows above are laid out from estimates again in a list made anew and
  an offset alone would name another message. It is restored for the same topic only, after the
  list's and the page's own opening scrolls to the end; a message no longer loaded leaves the
  conversation at its end.

## Where

| Page | Column 2 | Column 3 (its item) |
| --- | --- | --- |
| Topics (chat) | the topic list | the conversation (the topic) |
| Contacts | the library (of the tab it was left on) | the open contact, panel or phone pane (the contact) |
| TODO | the list, the calendar | the editor (the task, heartbeat or day) |
| Memories | the index | the main column (the subject or the journal) |
| Skills | the index | the open skill (the skill) |
| Usage | the page's body (its one column) | |
| Audit | the file index | the ledger, the task ledger (the file, or tasks) |
| Settings | the section list | the section (the section) |

Not remembered: dialogs, menus and popups, the workbench, the chat's workspace panel, the detail
panes opened from a column 3 row (Audit's entry pane, Settings' side panes), nested scrollers
inside a column (code blocks, a file preview), and pages outside the navigation (Logs, Context,
the skill store).

## Platform notes

- Headless and on the web, a `List`'s rows going with a page shrink its content before the list
  goes, and the scroller reports the offset it was pulled back to: the content's end headless, the
  top in a browser.
- A browser puts a scroller back at its top, without any report, when the view around it is
  moved. nsh orders siblings by `zIndex` by moving their views, which the page host does to the
  page that arrived as a phone's slide ends: the host tells the memory (`notePageSettled`), and
  the places restored in that page are applied again.

## Checks

- `tests/scroll-memory.test.tsx` (the helper on a fixture of the page host): first use, a `Scroll`
  and a `List`, independent areas, pages and agents, the selection rules, late content, `ready`,
  shorter content, content too short to scroll, a collapsed list, the reader scrolling during a
  restore, and the memory's lifetime (nothing stored, a new app starts fresh).
- `tests/scroll-memory-pages.test.tsx` (the console itself): the sidebar between Topics and
  Contacts (lists and the conversation's message), a conversation left at its end, another topic,
  a settings section and another section, the phone's bottom navigation, and no storage, host call
  or request from scrolling.
- `tests/scroll-memory-contact-tabs.test.tsx`: the Contacts library's place and its tabs.
- Chrome (headless, the built web Console with stubbed API), 1280×800 with a mouse and 390×844
  with touch: the topic list, the Contacts library and the conversation's message came back at
  the same pixel from the first sample after the navigation and stayed there through the phone's
  slide; `localStorage` and `sessionStorage` gained no key; a reload started at the top.
- Not checked: the desktop app (GPUI) and the Android app on a device, Safari and Firefox.

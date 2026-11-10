# Chat scroll position while a task runs

The Console's conversation (`web/console-nsh/components/chat/ChatHistoryList.tsx`) is an nsh 0.4.0
`List`. This note records why a reader scrolled up in a running conversation was thrown somewhere
else, how it was reproduced, what changed, and what was checked (FT63).

## Symptom

While a task ran, a reader who scrolled up and stopped saw the view jump: the text they were
reading slid up as the reply streamed, or the whole screen changed to other messages, often when
the task finished.

## Reproduction

- **Real Console in Chrome.** `mistermorph console serve` with the built web Console and a mock
  OpenAI-compatible endpoint that streams a long final reply in 60-byte chunks (one every 0.4 s),
  driven by Playwright (headless Chrome, 1280×800 with a mouse, and 390×844 with touch): open a
  topic with finished turns, send a message, scroll up (wheel, or a touch drag), then sample the
  list's `scrollTop`, `scrollHeight` and the message at the viewport's middle every 100 ms until
  the task has finished. Output guarding defers the Console's live reply snapshots
  (`guard.enabled: true`), so the scratch configuration turned it off to see the reply stream.
  With the original code, every scrolled-up run held still while the reply streamed and jumped
  when the task finished:

  | Run | `scrollTop` at the finish | On screen after |
  | --- | --- | --- |
  | Desktop, 800 px up, reply out of view | 11159 → 604 | another turn's reply |
  | Desktop, 300 px up, inside the reply | 17805 → 1993 | an earlier reply |
  | Phone (touch), 300 px up, inside the reply | 25842 → 0 | the oldest messages |
  | Desktop, inside the reply, browser scroll anchoring off (`overflow-anchor: none`) | 18767 → 2955 | an earlier question |

  At the bottom, 4.5 s after a send, `scrollHeight` also fell from 8103 to 3680 in one step,
  consistent with measured rows going back to their estimated height.
- **Headless.** `tests/fixtures/chat-scroll-anchor-app.tsx` mounts the real `ChatHistoryList`
  with a running reply and changes its items the way `chatController.ts` does. On the original
  code `tests/chat-scroll-anchor.test.tsx` fails 7 of its 14 cases: the scrolled-up streaming
  cases (desktop and phone), the finished task's reload, a reload alone, the phone's following at
  the bottom, and resuming after scrolling back down.

## Root cause

Two behaviours of nsh 0.4.0's `List`, one triggered by how the chat updates its items:

1. **`List` tells items apart by identity.** The runtime diffs `each` with `===` (nsh-js
   `list.rs`, `items_run`); `keyExtractor` is only used for viewability tokens. The controller
   updates a message by copy (`patchHistoryItem`: `{ ...item, ...patch }`), so every streamed
   snapshot, tool step or status replaced the running reply, and when a task finishes
   `refreshHistory()` reloads the page of tasks and replaces every message with a new object under
   the same id. The core turns each replacement into a splice (nsh-core `list.rs`, `splice`): the
   replaced rows lose their measured heights for `estimatedItemSize` (180 pt), the scroll pin is
   dropped, and the anchor that keeps the visible rows in place is only taken when the first
   visible row lies after the replaced range. A reader inside the replaced range (the running
   reply, or anything when the whole page is replaced) had no anchor, and the list was laid out
   again from estimates: the jump at the finish and the collapse of `scrollHeight` above.
2. **An inverted list keeps its distance from the bottom.** For a row that lies across the
   viewport's bottom edge it moves nothing (`measured` only compensates rows wholly before the
   viewport). Once the rows kept their identity, the headless runs showed the part of the running
   reply being read pushed up by as much as the reply grew below the viewport (408 pt for three
   streamed chunks on the desktop, 636 pt on the phone). Chrome did not show this movement with
   the original code; the desktop app (GPUI) and Android lay the list out with the same core.

Not causes: the controller's explicit scrolls (`scrollHistoryToBottom` runs on loads and sends
only), stale index targets (the pin is dropped by the splices), and the browser's own scroll
anchoring (the jump happens with `overflow-anchor: none` too, and the headless engine, which has
no browser, reproduces it).

A third behaviour appeared once the list was no longer inverted: nsh 0.4's
`maintainVisibleContentPosition` (`anchor_end`) compares the old end of the content with an offset
that has already been moved for rows that changed above the viewport. A reader scrolled up by less
than the height of an older page that arrived above (or of a row above that grew) was sent to the
bottom.

## Fix

In `ChatHistoryList`:

- The `List` gets the messages' ids (strings, equal while a message only changes; the array itself
  is kept while the ids are the same) and each row looks its message up by id. A message changes
  in place and its row is measured again, which the core anchors; only new, removed or reordered
  messages change `each`. A row bound to a message that was just removed keeps its last message
  until it is bound again.
- The list is not inverted. `maintainVisibleContentPosition` follows the end while the reader is
  at the newest message (within 32 pt, `HISTORY_FOLLOW_THRESHOLD`) and is turned off, from the
  list's own scroll reports, while they are scrolled up. Off, the list keeps the visible rows in
  place for changes above them and changes nothing for changes below or across the bottom edge;
  back within the threshold, following resumes.
- It opens at its end before the first frame (`scrollToEnd` in the `ref`), the "Load older"
  button is a header above the oldest message, and the paddings are no longer mirrored.
  `chatController.ts`'s `stickToBottom` (sends and loads) is `scrollToEnd`.

Virtualization, the estimated size, row recycling, arrivals and the controller's update paths are
unchanged. One visible difference: a conversation shorter than the viewport now starts at the top
of the history, as the Vue console's did (`align-content: start`), instead of resting on the
composer.

## Checks

- Chrome, the built Console with the fix, the same runs as above: scrolled up 800 px, and inside
  the reply on the desktop (with and without the browser's scroll anchoring) and on the phone
  with touch, the message at the viewport's middle stayed at the same pixel from the scroll until
  well after the task finished, through every streamed snapshot. At the bottom, `scrollTop`
  followed `scrollHeight` through the stream. Five topic switches (desktop, in the app)
  and opening each topic (phone) put every one at its newest message (`scrollHeight − scrollTop −
  clientHeight` = 0).
- `tests/chat-scroll-anchor.test.tsx` (desktop 1000×800 `linux`, phone 390×844 `android`):
  scrolled up inside and above the running reply through streamed text, tool steps and the
  finish; a reload with new objects; an earlier message growing above the viewport; older pages
  (also one taller than the way back to the bottom); following at the bottom; resuming after
  scrolling back down; a send while scrolled up; a topic switch opening at its newest message.
  Headless, the screen does not report the list's own scroll corrections back, so the test
  scrolls a point and back before it reads positions.
- Not checked: the desktop app (GPUI; no display on the build machine), the Android app on a
  device or emulator (none available), Safari and Firefox, a visible (headed) browser, and a real
  model's stream. The headless phone tests run nsh's Android platform model, not a device.

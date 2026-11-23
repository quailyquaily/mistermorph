# Polish the "Load older topics" button in the topic list

## factory · 2026-11-23 11:33
Owner request:
> the "load more topic" button, need to polish the ui and ux
> add to new/

### Where it is
The button at the end of the Console's topic list that fetches the next page of topics: label `chat_topics_load_older` ("Load older topics"), drawn in `web/console-nsh/pages/chat/TopicSidebar.tsx`, backed by `loadOlderTopics` in `web/console-nsh/pages/chat/chatController.ts`. The search note `chat_topics_search_older` ("Load older topics to search further back.") belongs to the same control.

### Expected behavior
- The control reads as part of the topic list, not as a form button dropped under it: its size, weight, inset and alignment follow the list's rows, on a desktop sidebar and on a phone.
- Each state is clear and says one thing: idle; loading (busy from the press until the page arrives, and not pressable twice); failed (says so, and can be tried again); and nothing older left (the control goes, with no dead button or leftover gap).
- Loading older topics keeps the reader's place: the list does not jump, and the new rows appear where the control was.
- It works in every view of the topic list that shows it (the flat list, the grouped or tagged view, and while a search is on, where the note above applies).
- Keyboard and screen readers: reachable by Tab, a visible focus mark, an accessible name, and the busy state announced.
- Restyle what is there. Do not add new elements to the topic list (no counters, badges or extra buttons); if a state can be shown by the control's own look, do not add words for it.

### Decisions left to the build
The request does not say what is wrong today. Look at the control as it is (desktop and phone width, light and dark), list what is off, and fix that; record what was found and what was changed. Whether older topics should load by themselves on reaching the end of the list instead of on a press is open: keep the press unless loading on reach is clearly better and does not fetch without need.

### Acceptance checks
- Idle, loading, failed and no-more states each look and behave as above at desktop and phone widths, in the light and dark appearances.
- A second press while loading sends no second request; a failed load can be retried and then succeeds.
- The scroll position holds when older topics arrive.
- Regression coverage for the states and the single request per press. Run `nsh check` and `web/console-nsh/scripts/test.sh`.
- Look at the result in the running Console; record any visual check that could not be made.

Scope: the topic list's load-older control and its note only; no change to how topics are paged by the agent, and no redesign of the topic rows.

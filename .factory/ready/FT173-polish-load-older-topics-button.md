---
branch: factory/FT173-polish-load-older-topics-button
round: 1
---
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

## factory · plan · 2026-11-23 12:24

Behaviour: Keep explicit press-to-load in flat, grouped/tagged and searched topic lists. A list-width, row-aligned control has idle, busy (disabled, announced), and failed/retry states without extra badges/buttons. Exhaustion removes the control and its own padding. Keep current rows visible and scroll offset stable while appending older topics. Duplicate presses never start another request; failure preserves cursor/data and retry works. Reset pagination error appropriately on refresh/context changes.
Scope: TopicSidebar load-older control, its search note, narrowly scoped controller pagination error state and regression coverage. No backend pagination, topic-row redesign, auto-fetch, unrelated UI or configuration changes.
Decisions: Keep manual pagination; no fetching without explicit need. Current centered small plain form button with external vertical padding does not follow list row dimensions/alignment; its loading uses generic Button and its failure is only global err, so introduce a scoped visible failed state in the same control. Inspect actual desktop/mobile light/dark rendering if available and document limitations honestly. Reuse existing design primitives and semantics rather than inventing a new UI system.
Checking: Cover idle/loading/failure/retry/exhaustion, concurrent press guard, each list view/search note, row preservation and scroll stability. Run nsh check and scripts/test.sh, plus test -z "$(gofmt -l .)" && go vet ./... && go test ./.... Scripted tests use absolute throwaway HOME under TMPDIR. Record all unavailable visual/manual checks.

## factory · 2026-11-23 12:24

Built and pushed `77a9e7d4` on `factory/FT173-polish-load-older-topics-button` (start: `4ba41b9a`).

Findings: the old 38pt label-sized button did not align with 40/44pt topic rows, lacked visible keyboard focus/busy semantics, and failure appeared only globally. An older pinned topic could shift the list by 78px.

Changes: row-aligned full-width control with existing row metrics/insets and icon column; stable spinner and accessible busy name; inline failed/retry state using the same control; disappearance without control spacing at exhaustion. Keep explicit press-to-load. Busy presses are ignored while retaining focus (rather than disabled, which lost keyboard focus in Chrome). Scoped pagination state prevents concurrent loads and discards in-flight pages after agent switch; failure preserves data/cursor and retry works. Anchor measurement compensates for older rows inserted above the reader. Search note unchanged. English/Chinese/Japanese labels updated; adjacent history-control comment corrected, no history behavior changes.

Installs: none; existing pinned nsh 0.6.0, playwright-core and Chrome used.

Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`; `nsh check`; and `web/console-nsh/scripts/test.sh` (160 files, 0 failed, 251s). Coder also passed all checks; 18 new regression tests cover single request, retry, scope reset, geometry, state transitions, keyboard Space, grouped/search views and scroll anchoring. No forbidden paths changed; one focused code commit, clean worktree.

Visual/manual: coder inspected actual running Console with a stub API in Chrome at desktop 1280x800 and phone 390x844, light/dark, including idle/loading/failure/exhaustion, focus, retry, duplicate input, and scroll retention. Limitations: only date view inspected in Chrome (tag/search headless only); dark screenshots predate shorter final retry label (final label inspected in light only). No real screen reader, physical mobile device or desktop app. Accessibility announcements checked by ARIA attributes only. Exhaustion removes a focused control and returns focus to page. Review should examine these remaining visual/accessibility cases.

## factory · review · 2026-11-23 14:43
head: 77a9e7d41d9c4652dba27146287255dd635a6534
verdict: pass
notes:
- Claude Code reviewed all 11 files in origin/master...HEAD against the request and plan; no P0/P1/P2/P3 findings. Merge with current master (4ba41b9a) is clean.
- Required Go gate passed: clean gofmt, go vet ./..., go test ./... (168 tested packages; exit 0). nsh check passed. Console scripts/test.sh passed: 160 files, 0 final failures, 392s; eight parallel-pass failures all passed the script's isolated retries. Extra Node tests passed. Worktree unchanged; no installs or manifest changes.
- Review did not repeat browser visual checks. Builder's desktop/phone light/dark Chrome checks and headless geometry tests remain the visual evidence; final shorter retry label was not rechecked in dark. Real screen reader, physical phone and desktop app remain unchecked.
- Residual coverage: middle tag-group insertion scroll anchoring and focus during first-page refresh were not verified; last-row/pinned anchoring covered. Focus returning to page on exhaustion is pre-existing, not introduced.
- Moved review/ → ready/.

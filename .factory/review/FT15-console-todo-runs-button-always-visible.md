---
branch: factory/FT15-console-todo-runs-button-always-visible
round: 1
---
# Always show the TODO runs button in Chat

## factory · 2026-11-05 11:09
Owner request: “这个按钮应该始终显示。添加到 new 吧”

Follow-up to FT11 (Console cron topics). The Chat sidebar's alarm-clock button, labeled “TODO runs / 待办运行”, must always be visible, including before any TODO has run or created a dedicated topic.

Acceptance criteria:
- Do not condition button visibility on the existence or count of TODO run topics.
- The button remains clickable when there are no run topics; selecting it shows a clear empty state rather than hiding the entry or displaying ordinary chat topics.
- Clicking again returns to the ordinary topic list, preserving existing filtering behavior.
- Add regression coverage for zero run topics and for existing run topics.

Scope: button visibility and the empty filtered view only; do not migrate historical Awareness records or change scheduling behavior.

## factory · plan · 2026-11-05 12:32
**Behaviour**
1. The TODO runs button (the alarm clock) is in the chat sidebar's header whenever the sidebar is, whether or not a TODO item has run.
2. Pressed with no TODO run topic, the list shows no topic at all, only a note: no TODO item has run yet, and an item's runs will appear there in a topic of its own. The button shows as pressed.
3. Pressed again, it returns to the date list, as it did before; the TODO view is still not remembered across visits.
4. With TODO run topics, the list is unchanged: those topics only, the latest run first.

**Scope**
- `web/console/src/views/ChatView.js`, a new `web/console/src/core/chat-cron-topics.js` (the TODO topic helpers, moved out of the view so they can be tested), the empty note's text (en, zh, ja), and `docs/console.md`.
- Left out, as the request says: earlier runs recorded in Awareness, and scheduling. Also left out: the agents button beside it, which still shows only once another agent has messaged.

**Decisions**
- "Always" means whenever the sidebar is shown. A Console with no topic at all still opens on its bare first screen, without a sidebar, so the button is not there either; showing the sidebar there is a change to that screen, not to the button.
- Returning goes to the date list even if the tag view was open before, as the agents button does; the request asks to keep the existing behaviour.
- The empty note says what will appear, not only that nothing has.

**Checking**
- Console: the button's markup has no condition; the TODO view's list for no run topics (ordinary, Agent Link and Awareness topics present) is empty, and for existing ones holds them only, latest first; the empty note's condition and text.
- By hand: the button, the empty note and the way back, with no run topic and with one, at desktop and phone width.

## factory · 2026-11-05 12:32
Built at the owner's word in chat ("check FT15. please implement that"), in the factory's build directory, outside the scheduled run: 4328cb24, from master 353bdd87.

Installs: none.

Tests: `pnpm test` 390/390 and `pnpm build` pass. gofmt, `go vet ./...` and `go test ./...` pass, with a throwaway HOME, on the second run. The first run failed once in `cmd/mistermorph/consolecmd`, which this branch does not touch:

    --- FAIL: TestLocalChatConnectionWithoutConfiguredToken (0.00s)
        local_chat_test.go:64: console stop did not cancel the service

That is a flake on master: the `/shutdown` handler sends its reply before it cancels the service, and the test looks for the cancellation as soon as the reply is in. The test passed 30 repetitions on its own. Not fixed here.

Looked at in a browser, on this build with a throwaway home and a stand-in LLM: with one ordinary topic and no TODO run, the button is there; pressed, the list shows only the note, and pressed again the topic is back; after a TODO item ran, the TODO view lists its topic and no note. At phone width (about 400px) the button is in the topics pane. No console errors.

Not checked: zh and ja wording in the UI; a Console with no topic at all, which has no sidebar (see Decisions).

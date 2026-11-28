---
branch: factory/FT198-composer-hide-empty-suggestions
round: 1
---
# Composer: hide the suggestion popup when there is nothing to suggest

## factory · 2026-11-28 14:59
Owner request, translated: when the matched commands, matched skills and similar lists are empty, do not display the empty suggestion UI. Example: while typing an absolute path in the Morph composer, a "COMMANDS / No matches" box appears above the composer. Queue only; no implementation, build or ship in this intake. This is separate from FT197 (image paste) and changes only the suggestion popup.

### Source evidence (origin/master 31a944fb9cea0666e25188cfd3ad3a76d1dfddcb)
- Providers. Only two suggestion types exist: `/` commands and `$` skills. `web/console-nsh/lib/core/chat-composer-suggestions.js:114-142` (`composerTriggerContext`) opens a `command` context for any whitespace-delimited token before the caret that starts with `/`, and a `skill` context for one that starts with `$`. There are no mention, file, path or other providers. The popup shows exactly ONE category at a time. "Mixed" sections do not exist today, so the requirement must not invent them.
- Why paths trigger it. An absolute path such as `/Users/me/project` or `/home/x` is a `/` token with the query `Users/me/project`. `buildComposerSuggestionItems` (`:224-242`) substring-matches the query against value, title and description (`:215-222`) and caps the list at 8 (`:1`). A path usually matches nothing, so the list is empty. A bare `/` (empty query) lists every command. Command source: commands loaded from the endpoint, else the built-in `COMPOSER_COMMAND_SUGGESTIONS` (`:3-108`, `:234-238`). Skill source: the `skills` prop.
- The popup shows for any context, even an empty one. `web/console-nsh/components/chat/ChatComposer.tsx`:
  - `:288-289`: `suggestionsVisible = suggestionContext() !== null`.
  - `:953-976`: renders the listbox `chat-composer-suggestions` with its title (`:955`, from `suggestionTitle` `:294`) and the empty text (`:972-974`).
  - `:295-299`: the empty text is "Loading..." while skills load, the skills load error, else `labels().empty` ("No matches"; `lib/i18n/index.js:603`, 中文 `:3012`).
- The empty popup also captures keys and Enter:
  - `:453`: `trackPopup` counts it as an open popup, so a page's own Escape (side panels, `components/ui.tsx:997-1016`) is held back.
  - `:457-472`: while it is "visible", Up, Down, Tab and Escape are bound with `when: "always"`. Up/Down do nothing on an empty list and the input-history Up/Down (`:474-485`) is unavailable.
  - `:338`: `submitBehavior` is forced to `"submit"`.
  - `:564-571`: `onSubmitKey` returns without sending or applying when the list is empty.

  Result: with an empty "No matches" popup, Enter neither sends (desktop, `submitOnEnter`) nor inserts a newline where Enter is a newline (phones, or wherever application shortcuts are off, `:335-338`). Tab is swallowed too.
- Selection and lifecycle:
  - `:290-293`: the active index is clamped to the list length.
  - `:189-191`, `:355`: the index resets when the context (type/query/start/end) changes.
  - `:340-343`: `closeSuggestions` clears the context and index.
  - `:1156-1165`: `onChange` and `onSelectionChange` call `syncSuggestions` (`:345-359`), which also triggers `onRequestCommands`/`onRequestSkills`.
  - `:406-420`: `applySuggestion` replaces the token.
  - `:505-507`: disabled closes the popup.
- Loading and error data (`web/console-nsh/pages/chat/chatController.ts`):
  - Skills: `:1358-1386`, with `composerSkillsLoading`/`composerSkillsError` passed by `pages/chat/ChatPage.tsx:67-76`. Skills therefore have intentional "Loading skills..." and load-error feedback.
  - Commands: `:1388-1404` has `composerCommandsLoading`, but it is NOT passed to the composer. A failed or empty load leaves `[]`, and the list falls back to the built-ins, so commands have no loading or error UI today.
- Composer users. The shared ChatComposer runs on Web, desktop (macOS/Windows/Linux), Android and iOS (nsh, one component).
  - `pages/chat/ChatPage.tsx:67-76,137-138` passes commands, skills and loading/error data.
  - `components/todo/TodoIndex.tsx:253-272` (Todo compose) passes no commands or skills. There `/…` uses the built-in command list and any `$…` token always shows "Skills / No matches".
  - `pages/ui-components/demos/chat.tsx:73-75,103-104` is the demo.
- Existing tests:
  - `web/console-nsh/tests/chat-composer.test.tsx:39-53` (`/co` → `/compact`).
  - `:162-188` (arrows, Tab, Escape).
  - `web/console-nsh/tests/chat-detail-panel.test.tsx:212-226` (Escape closes suggestions before the panel).
  - No test covers the zero-match case.

### Requirement
1. Show the popup only when it has something to show. Let "shown" be:
   - a trigger context exists, AND
   - (the current list has at least one candidate, OR the context is `skill` and skills are loading or have a load error — the existing intentional feedback).

   With zero candidates and no loading/error state, render nothing: no listbox, no "COMMANDS"/"SKILLS" title, no "No matches" text, no padding or `border-b` shell, and no layout jump in the composer frame. With candidates, rendering, titles, ordering, the 8-item cap, descriptions and selection look are unchanged.
2. Use that same "shown" predicate everywhere the current `suggestionsVisible` gates behaviour:
   - the popup render,
   - `trackPopup`,
   - the Up/Down/Tab/Escape keymap,
   - `submitBehavior`,
   - `onSubmitKey`.

   While hidden:
   - Enter does what it does with no popup: send where Enter sends, newline where it is a newline. IME composition is unaffected.
   - Tab, Up, Down and Escape keep their normal composer and page behaviour: Up/Down input history where eligible, caret movement otherwise; a page or panel Escape is not held back; edit-cancel Escape still works.
   - Pressing keys never changes the text or caret except as the field normally would.
3. Keep tracking the trigger context while hidden. Do not change matching or trigger rules. When the token changes and matches again (for example an unmatched `/helx` becoming `/help`, or backspacing to `/`), or the async commands/skills arrive and match, real results appear without retyping. The active index resets to the first item when the popup reappears for a different context, and is never out of range or pointing at a candidate from before (no stale selection after empty → non-empty or after the provider list changes). Applying a suggestion, Escape on a shown popup, blur or disable keep their current semantics.
4. Feedback. Keep skill loading ("Loading skills...") and skill load-error feedback visible as today, including when they would otherwise be empty. Do not add new loading or error states for commands. Out of scope: leaving behaviour that triggers per keystroke unchanged, `ensureComposerCommandsLoaded` re-requesting `/commands` while its list is empty (`chatController.ts:1388-1389`), and the Todo composer's missing skills feed. Record them if observed. If the `chat_composer_suggestions_empty` label becomes unused, removing it or keeping it is the implementer's choice; do not repurpose it.
5. Accessibility. No empty `listbox` is exposed to screen readers. A shown popup keeps `role="listbox"`/`option` and its selected state.

### Acceptance and regression tests (Console test suite, `web/console-nsh/scripts/test.sh`)
- Zero matches, commands. With `/commands` returning items and with the built-in list, typing `/Users/me/project`, `/home/x/y` and `/zzzz` shows no `chat-composer-suggestions`, no "Commands" title and no "No matches".
  - Desktop: Enter sends the path as the message, with no extra newline and no lost text.
  - Phone/shortcuts-off: Enter inserts a newline.
  - Tab and arrows do not change text or caret beyond normal field behaviour. Up/Down history works when eligible.
- Zero matches, skills. With loaded skills, `$nomatch` hides the popup. While skills load, `$` shows the loading text. On load error, the error shows. After load with results, `$` lists them and `$nomatch` hides. In the Todo composer (no skills), `$x` shows nothing and Enter works there as without a popup.
- Non-zero. `/`, `/co` and `$` with matches show the title and options exactly as now, and the existing tests `chat-composer.test.tsx:39-53,162-188` still pass.
- Transitions:
  - `/` (shown) → `/U` (hidden) → backspace → `/` (shown again, index 0).
  - `/hel` → `/helx` (hidden) → `/hel` (shown, first item selected, not an earlier index).
  - Async: type `/al` before `/commands` resolves to `/alpha`; when it resolves, the popup appears with `/alpha` selected.
  - Moving the caret into and out of a `/path` token mid-text.
  - Switching endpoint/topic or disabling the composer while a popup is hidden or shown.
- Escape:
  - With the popup hidden on a `/path` token and a side panel open (pattern of `chat-detail-panel.test.tsx:212-226`), Escape closes the panel at once.
  - With the popup shown, the first Escape still closes the popup only.
  - Edit mode: Escape cancels the edit while the popup is hidden.
- "Mixed" category behaviour: assert that only one category renders at a time (current design). If a future provider adds a second section, empty sections must be hidden individually. Not required to build now.
- Cross-platform. One shared component: the tests cover the desktop/web Enter-sends path and the phone/shortcuts-off newline path through the existing shortcut-policy fixtures. Manually check on Web, a desktop build, Android and iOS that typing an absolute path shows no empty popup and Return behaves normally. Report each platform as tested or NOT TESTED, with OS/runtime.

### Unverified
No build, test, device or browser run in this intake. All behaviour above is from source. Native keyboard Return on Android/iOS with `submitBehavior` "submit" vs "newline" is inferred from nsh props and has not been observed. Screen-reader output for the hidden and shown popup has not been checked.


## factory · plan · 2026-11-28 16:47

### Behaviour
Keep detecting command/skill trigger context even with zero matches. Show the shared suggestion popup only with candidates or intentional skill loading/error feedback. Use this predicate for rendering, popup tracking, keyboard bindings and Enter handling. Hidden results leave normal field/page behaviour untouched; new matching text or asynchronously arriving data restores results with a valid fresh selection. Retain existing dismissal, disabled, blur and IME semantics.

### Scope
Change the shared Console composer and focused regression tests (including page Escape integration). Do not alter matching/providers, request frequency, Todo skills wiring, translations, native runtimes or unrelated image-paste work.

### Decisions
Use one derived visibility predicate, not clearing context on zero matches. Reset selection when the candidate identity sequence changes so provider updates cannot select stale results. Preserve existing skill loading/error text, but when no candidates exist expose feedback without an empty listbox (e.g. status role); candidate lists retain listbox/options. The source instructions saying queue-only describe the prior intake; this scheduled build implements its explicit Requirement. Keep unused empty labels unless cleanup is necessary. No manual platform result may be inferred from automated tests.

### Checking
Add coverage for command paths and unmatched skills, desktop send versus shortcuts-off newline, normal key/history/edit Escape behaviour, page Escape precedence, shown/hidden transitions, caret movement, async provider changes and selection reset, loading/error feedback, single-category accessibility and disable/topic reset where fixtures permit. Run nsh check and the required parallel Console scripts/test.sh suite, plus configured gofmt/vet/go-test command. Report Web, desktop, Android, iOS and screen-reader manual checks separately as NOT TESTED unless actually observed.

## factory · 2026-11-28 16:47

Built commit `96aa4496`: hidden zero-match command/skill suggestions no longer intercept Enter, arrows, Tab or Escape. Skill loading/error feedback remains, without an empty listbox. Candidate selection resets when its context or candidate sequence changes. External draft changes close stale suggestions. Matching/provider requests and Todo skill wiring are unchanged.

Checks: manager independently verified protected paths unchanged; configured gofmt + go vet ./... + go test ./... passed; nsh check passed; full Console scripts/test.sh passed (179 files, 0 failures). Coder added command/skill, keyboard/Enter, async/provider-selection, topic-switch, edit and side-panel regressions. No installs.

Not checked: manual Web (Linux host), desktop (macOS/Windows/Linux), Android, iOS and screen-reader interaction: NOT TESTED; no browser/device/runtime session was opened. Native caret movement is not exercised by the headless runner; endpoint switching not tested (topic switching covered). Per-keystroke command requests and Todo missing skills feed remain out of scope.

Coder reported two out-of-scope memory writes under its own Claude project memory (item note plus MEMORY.md); no machine paths committed. No newly observed /tmp entries. Initial branch push required command-local credential.useHttpPath=true; retry succeeded. Branch is ready for review, not shipped.

## factory · review · 2026-11-28 16:55
head: 96aa4496a2d9e4ab82420f5f31672359ed6b6cc8
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (base 31a944fb) against the request and plan; no qualifying P0/P1/P2/P3 findings. Branch merges cleanly with base; worktree and head unchanged.
- Required gofmt, go vet ./..., and go test ./... passed. nsh check passed (installed nsh 0.6.0). Required parallel Console scripts/test.sh passed: 179 files, 0 failed, 306s; chat-scroll-anchor and settings-integrations-channels passed their isolated retries after parallel failures.
- Supplemental node lib tests reported a failure in unchanged lib/core/solo.test.mjs (a task's thread record). Baseline reproduction was not established; not a failure of the configured required checks.
- Manual Web/browser, desktop macOS/Windows/Linux, Android, iOS, native phone Return, and screen-reader interaction NOT TESTED. Live caret movement and endpoint switching remain unverified (topic switching covered). Skill feedback has no web status role; Android live-region announcement is configured, not manually observed.
- No installs. Coder reports no writes outside the worktree/TMPDIR except permitted shared-cache reads; manager observed no new top-level /tmp entries. Ready for owner approval, not shipped.


## factory · 2026-11-28 20:00

Shipped to master in merge commit a1e439b424c98e7cac2794b69d5621b604e6bcfe; annotated release tag v0.3.146. Atomic master/tag push succeeded. Moved ready/ → done/. No linked issue/PR to close; remote feature branch retained (clean is not configured).

Checks on merged base: gofmt, go vet ./..., go test ./... passed (173 packages); nsh check passed; required Console scripts/test.sh passed (181 files, zero final failures, Chrome paste harness included). Desktop cargo test --locked --offline passed: 102 unit + 1 feature + 5 paste tests, 5 ignored. Existing system runtime libraries were used through run-local metadata/linker shims; no installs or source fixes.

NOT TESTED during ship: Android compilation/packaging, iOS packaging, real OS clipboard/menu/device/consent paths, screen readers, mobile packaged-runtime equivalence, deployed ingress and live provider budgets. Headless Chrome injection is not OS acceptance. Lower provider-specific request budgets remain a documented limitation. No deployment or user-checkout changes.

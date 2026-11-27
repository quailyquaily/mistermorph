---
branch: factory/FT193-setup-console-user-name
round: 1
---
# Ask how to address the user before the existing Setup steps

## factory · 2026-11-27 07:37
Owner intake: add an independent new/ requirement, not an implementation. Add the first Setup page asking “应该如何称呼你” (“What should we call you?”), and use the answer as the Console user's name. Persist it in the correct user identity source, keep related displays consistent, and do not rename the Agent or introduce unrequested complex flows.

### Verified baseline and duplicate check
Inspected master at 289c27b3 and every numbered Markdown item on factory_board through FT191. No item already requests this page or a configurable Console human display name. FT81 changes Agent name selection; FT189 displays participating workers. Neither is the human identity requested here.

- pages/setup/setup-state.ts defines llm → persona → soul → done, step metadata, progress, per-step save and route synchronization; SetupPage.tsx renders the wizard. lib/router.ts and lib/core/setup.js define setup routes, guards and readiness. There is currently no user-name stage.
- cmd/mistermorph/consolecmd/local_runtime_bus.go defines consoleParticipantKey = "console:user", consoleUsername = "console", and consoleDisplayName = "Console User". The display constant feeds task conversation creation and inbound bus messages. solo.go also creates conversations with that constant.
- internal/chathistory/tasks.go TaskInbound independently hardcodes Nickname = "Console User". components/todo/todo-model.js uses todo_chat_console_user as a label. These are identity consumers to audit, not proof of an existing editable profile.
- /auth/me in cmd/mistermorph/consolecmd/serve.go returns the fixed account "console". console_settings.go has no human display-name field; its configuration writes use internal/configstore. Agent identity/soul live behind the persona-profile abstraction and must not become the human profile store.

### Required behavior and scope
1. Add one small first page before LLM, asking the localized equivalent of “应该如何称呼你”. It contains a labeled single-line text field and the existing Continue action, with the current wizard's components, spacing, keyboard behavior and progress treatment. Update stage order, routes, Back/Continue and completion metadata. No avatar, email, password, registration, verification or separate account system.
2. Save the name on an explicit Continue; proceed only after the server confirms success. On failure keep the input and show the existing inline error/retry treatment. Leaving an unsaved page does not alter the saved name. Revisiting loads the stored value for editing; continuing unchanged is safe.
3. Use one durable, server-owned Console human profile value, scoped to the existing Console identity (console:user), not a selected Agent's persona or a browser/device preference. The baseline has no configurable human-name source: extend the existing Console configuration persistence via configstore with a narrowly scoped value such as console.user_name and an authenticated read/update surface, rather than inventing a parallel account database. If adding the config key, update assets/config/config.example.yaml and the applicable schema/settings validation. The same backend source must be used for UI reads and task submission; do not keep separate frontend/runtime copies that disagree after restart or change.
4. Keep stable identifiers console:user, console, approval actor IDs, authentication/session account, contact/reference IDs and routing unchanged. The answer is a display name, not a login credential. Never write it into Agent identity.yaml/name/name_alts, soul, endpoint names or Agent avatars; never rename an Agent as a side effect.
5. New Setup starts on this page. Existing configured installations with no saved name continue to work with the current Console User fallback; do not suddenly block normal chat or force onboarding on upgrade. When Setup is explicitly opened/reopened, put the name page first and prefill a saved name. Initial/resumed setup and direct routes must not accidentally skip the new first step for a fresh installation; preserve legitimate integrity-repair entry paths. Integrate with FT192 if present, but implement without requiring its Settings entry.
6. Normalize surrounding Unicode whitespace. Require 1–80 Unicode code points after trimming; reject blank/whitespace-only input, overlong input, embedded line breaks and control characters in both client and server validation. Support ordinary internal spaces, CJK and emoji. Show an actionable inline error; do not silently truncate. Render the value as text, never HTML/Markdown code, and enforce the same normalization/limit in all write paths.
7. Use the saved display name wherever the current Console human is named: new ordinary and Solo task conversation participants, inbound sender metadata, their chat-history/prompt projections, and current-user labels such as the TODO Console-user destination. Audit these consumers and update them from the common source; preserve unrelated Agent/coder/worker names and other channels' identities. A successful save updates relevant UI state without needing a logout; new submissions immediately use it. Keep historical event/task identity snapshots as recorded, rather than rewriting old history merely to rename the user; legacy records without a name retain the existing fallback. This distinction must not leave newly created task history hardcoded to Console User.
8. Use existing authenticated APIs, configuration update conventions and omission semantics. A name-only save must not modify passwords, secrets, channels, managed runtimes or unrelated Console settings. Do not put names into URLs or add new logging/analytics of profile content.

Out of scope: a profile-management product, multi-user accounts, per-Agent nicknames, changing stable user IDs, rewriting historical messages, or a new name-editing Settings page beyond the Setup field. FT192 separately supplies Settings re-entry.

### Verifiable acceptance criteria
- A fresh Setup shows the name question before LLM; successful Continue persists the trimmed value and follows the existing LLM/persona/soul flow. Progress, Back, reload/resume, direct routes and repair behavior have regression coverage.
- A saved CJK/emoji name survives browser reload, logout/login and server restart, and is returned consistently to another authenticated client of the same Console. Switching Agents does not replace it with an Agent name or write into a remote Agent persona.
- New ordinary and Solo tasks use that display name in conversation participants, inbound sender metadata and history/prompt projections; current-user TODO labels agree. Existing historical snapshots remain readable and unchanged. With no saved name, legacy behavior remains usable and old configured installations are not forced into Setup.
- Test empty, Unicode-whitespace-only, surrounding whitespace, internal spaces, CJK/emoji, 80/81-code-point values, line breaks/control characters and markup-looking text. Client and server agree; direct invalid API writes fail without changing the prior value; markup displays literally.
- Save errors preserve input, stay on the page and can be retried. Unauthenticated writes are rejected under existing auth rules. A name-only save leaves stable IDs, credentials, unrelated settings and Agent persona/name/avatar/soul unchanged.
- Cover persistence/restart and normal/Solo submission/history in Go tests; cover wizard navigation, validation, fallback and affected labels in Console tests. Check desktop and 360/390pt mobile with keyboard, light/dark and en/zh/ja labels. During implementation run configured Go checks, nsh check and web/console-nsh/scripts/test.sh; this intake performs no implementation or build/review/ship run.

## factory · plan · 2026-11-27 08:55

Behaviour
- Add a first, localized human-name Setup stage, with load, validation, explicit confirmed save, retained input on error and safe retry. Keep fresh direct/resumed routes from skipping it while preserving configured-install and integrity-repair behavior.
- Persist console.user_name with existing configstore conventions; read it through authenticated Console APIs and resolve current submission identity from the same server-owned source. Preserve stable identifiers and historical snapshots; fallback to Console User when absent.
- Normalize Unicode surrounding whitespace and validate 1–80 code points, no line breaks or controls, in client and server. Render literal text. Update current-user TODO labels immediately after save.
Scope
- Console config/settings/schema/example, authenticated profile read/write, ordinary/Solo submission metadata and chathistory projections, Setup routing/state/UI/locales and regression tests.
- No Agent identity changes, multi-user system, new profile Settings page or historical rewrites. No FT192 dependency.
Decisions
- Use a narrow console.user_name persisted setting, not persona or browser storage. Keep existing account/auth/routing identifiers. Retain Console User for missing legacy names. Follow existing API omission semantics so name-only writes cannot modify other settings.
- Apply the actual repository-pinned nsh version (AGENTS.md says 0.6.0), not the stale version mentioned in factory config.
Checking
- Go table tests for normalization, invalid writes, auth, unrelated-setting preservation, durable reload, ordinary/Solo inbound/conversation/history snapshots and legacy fallback.
- Console tests for navigation/resume/direct-route/repair, validation including code-point boundaries and Unicode, failed-save retention/retry, text rendering and TODO labels; en/zh/ja labels.
- Run gofmt cleanliness, go vet ./..., go test ./..., nsh check and scripts/test.sh. Use throwaway HOME and XDG/cache directories for scripted tests. Check UI sizes/themes/keyboard if a browser is available; explicitly report any visual checks not performed.

## factory · 2026-11-27 08:55
Built at 691189af (four topic commits from 289c27b3). Added authenticated, configstore-backed console.user_name; localized first Setup name page; validation and explicit-save retry; ordinary/Solo submission, inbound and history snapshot identity; current-user TODO labels. Stable IDs, authentication account and Agent identity remain unchanged. Historical snapshots are preserved with legacy Console User fallback.

Explicit generic Setup re-entry starts at the prefilled user page; automatic configured-install routing remains unblocked, unfinished setup resumes, and legitimate repair routes are preserved. CLI set (including parent object), import and edit normalize/validate names. Invalid hand-edited legacy values fall back on read. Older servers without the new auth/me property retain three-stage compatibility.

Checks: manager independently passed gofmt cleanliness, go vet ./... and go test ./... on final head. Claude Code passed nsh check (repository-pinned 0.6.0) and all 175 Console test files on final head. Added Go persistence/restart, auth, validation, ordinary/Solo/history and CLI-write tests; Console setup routing, failed-save retry, Unicode validation and labels tests.

Installs: none. Initial UI checked in headless Chrome with stubbed API at desktop 1280x800 and mobile 390x844/360x740, light/dark, en/zh/ja, keyboard Enter, Back, failed save and literal markup rendering. Final re-entry routing tested headlessly; visual probe not repeated after routing-only changes. Not checked: real mobile devices, desktop app window, on-screen keyboard overlap, screen readers or live-server browser end-to-end.

Review attention: FT192 is now ready but is not in the base; its SETUP_REENTRY_FIRST_STAGE must become user when integrating both, with likely Setup/locales conflicts. Runtime TODO API chat_options names still carry the old fallback and are relabeled by Console. Bulk template/legacy-state-copy writers are not validated at write time; read fallback remains. Review these against intake scope.

Claude reported an unsolicited auto-memory write outside the run directory during its first call, then stopped further memory writes when instructed. Harness task logs were written outside dir under its shared temporary directory; tracked for owner inspection, not deleted. No unpinned installs.

Move: new/ → review/; ready for independent review, not merged or shipped.

## factory · review · 2026-11-27 09:04
head: 691189afcf530ad536d4efae80208039f552109e
verdict: pass
notes:
- [P3] cmd/mistermorph/configcmd/configcmd.go:190: Whole-document name validation blocks unrelated config set/unset when a legacy/repair-edited name is invalid. Verified example: an 81-character name makes setting llm.model fail with the name-length error and leaves the file unchanged. Validate only affected name writes or provide an actionable repair path.
- [P3] web/console-nsh/pages/setup/setup-state.ts:932: Continue always writes the name, so an environment-managed console.user_name cannot continue even unchanged. Verified example: MISTER_MORPH_CONSOLE_USER_NAME=From Env and a same-name settings PUT returns 400 (managed by environment); the tested save-error path stays on the page. An invalid environment name also triggers the fresh-name route guard. Handle read-only environment-managed names without an impossible save.
- [P3] internal/configsettings/fields.go:131: The new settings-only validation does not cover the existing authenticated repair editor (setup_repair.go:173). Verified example: replacing Prior through the config repair PUT with an 81-character name returns 200; auth/me then returns an empty user_name and Console User fallback. Apply the same normalization/validation to this writer without losing the prior value.

Independent Claude Code review covered all 32 files in origin/master...HEAD (base 289c27b3), including authentication, config omission/persistence, Unicode parity, literal rendering, identity/history snapshots and Setup routes. No P0/P1 findings. Manager checked final worktree cleanliness and the finding locations. No code changes or commits made during review.

Validation on reviewed head: gofmt clean; go vet ./... and go test ./... pass (173 packages); nsh check 0.6.0 passes; required Console scripts/test.sh passes (175 files, zero failures after runner retries). agent-favicon and chat-topic-drag failed parallel runs but passed the prescribed isolated retry. Exhaustive Go/JS code-point validation comparison found zero differences. Extra non-required node tests: 322/323 pass; unchanged lib/core/solo.test.mjs has a failing thread-record test, reported as previously observed by the reviewer, not independently re-run on base.

Installs: none. Residual risks: no independent visual, real-device, desktop-window or live-server browser checks. Empty environment override, remote-Console TODO labels and contact-store markup handling were not fully verified. Runtime TODO labels still use fallback and are relabeled client-side. FT192 remains outside base; first-stage and Setup/locale integration must be checked when combining them. Template/legacy-copy writers remain unchecked at write time. Harness background-task outputs were written outside dir under its shared temporary folder; recorded for owner inspection, not deleted.

Move: review/ → ready/. Low-priority notes do not block the configured factory gate. Not merged or shipped.

## factory · 2026-11-27 10:44
Shipped on the owner's word ("merge the ready items, no new tag"). Merged into master as 591f0e4b. It conflicted with FT192 in web/console-nsh/lib/core/setup.js and web/console-nsh/pages/setup/setup-state.ts; the coder resolved it in the merge commit, keeping both: Setup opened again from Settings starts at the name page when the server keeps a user name and at the model page otherwise (`setupReentryFirstStage()` replaces the constant `SETUP_REENTRY_FIRST_STAGE`), the resume marker is stripped and the reentry marker kept; a link with both markers is treated as reentry. After the merge: `nsh check` passed, the Console tests passed (176 files, 0 failed), and the repository's test passed. Not checked: no test covers Settings reentry starting at the name page, and the page was not looked at in a browser; the Settings row text still names only the model, persona and soul steps. No tag was made, as the owner asked. No linked issue or PR to close. The branch was not deleted.

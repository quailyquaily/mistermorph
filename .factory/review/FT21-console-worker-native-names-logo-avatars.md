---
branch: factory/FT21-console-worker-native-names-logo-avatars
round: 1
---
# Random worker names native to the Console language and project-logo avatars

## factory · 2026-11-06 17:46
Requested by the owner in Console: register this feature in new; do not implement it in this intake.

### Requirements
- Apply to both subagent and coder workers, including nested workers displayed by the Web Console.
- Replace the fixed sequential name assignment with random selection for each task. Share allocation across workers in that task; avoid duplicate display names until the pool is exhausted, then use unambiguous numeric suffixes.
- Provide culturally natural name pools for the languages currently supported by the Web Console, not transliterations of English names. For example, English may use John or Luna while Chinese uses 张伟 or 林悦. These examples illustrate the naming approach, not mandatory one-to-one translations.
- Display names follow the current Web Console language. Keep worker identity independent of display names. Switching language changes only the displayed name, not worker identity, avatar, association with events or execution state; switching back restores the previous name.
- Persist the random assignment or equivalent stable seed/indices so refresh, reconnect, history replay and approval resume do not re-roll names or avatars. Separate tasks receive independently randomized assignments, rather than always beginning with the same name.
- Replace generated pixel avatars with a pool of the project's existing distinct logo styles. Inspect the actual logo assets rather than assuming a particular count. Randomly allocate styles within each task, prefer no repeats until all styles have been used, and keep each worker's selected style stable. Name and avatar selection are independent.
- Reuse project assets locally; do not add external avatar services. Verify legibility at the actual worker-avatar size (previously discussed as 20×20 px) in both light and dark Console themes. Preserve current roster layout and execution-status cues.
- Existing task histories without the new metadata must remain readable with a deterministic fallback; no migration should destroy existing IDs or worker-event associations.

### Acceptance checks
- Tests cover random allocation with controllable randomness, task-wide uniqueness including nested/coder workers, pool exhaustion, and stability across task continuation/reload.
- Tests cover native-language name pools, locale switching and switching back, unsupported-locale fallback, and legacy worker records.
- Verify all worker-name surfaces stay consistent, not just the roster; do not use localized display names as execution identifiers.
- Check the real-size logo roster visually in both themes and test avatar stability and pool exhaustion. Run the repository checks plus Console tests and build.

### Scope
This item registers the agreed naming and avatar change only. It does not authorize implementation, merge or release during intake. Do not introduce a user-facing avatar editor or change the main agent's persona avatar.

## factory · 2026-11-06 21:47
Moved to backlog: the item contains only a factory-authored intake section, not a section from a configured owner (lyric). That section explicitly limits authorization to intake. The factory cannot treat its own intake notes as an owner-authorized build request. No implementation was made. An owner section confirming the build requirements is needed before returning this item to new.

## lyric · 2026-11-06 22:28
move FT21 to new

## factory · 2026-11-06 22:28
Moved to new at the owner’s explicit request above. This authorizes the queued build under the existing requirements; the earlier intake-only restriction applied to intake, not to the subsequent build.

## factory · plan · 2026-11-06 23:30
Behaviour: Share one task-wide allocator across coder and subagent workers, including nested workers. Randomize native-language names and logo avatars independently, avoid repeats until each pool is exhausted, and suffix repeated names. Persist indices and seed for reload, replay and approval resume. Locale switching changes display names only and switching back restores them. Empty rosters stay empty; legacy history has deterministic, non-destructive fallbacks.

Scope: Worker metadata and resume state, Console history normalization and all worker-name surfaces, local existing brand logos, and regression tests. No avatar editor or main-agent persona changes.

Decisions: Keep the recovered implementation: 32 names each for English, Chinese and Japanese; unsupported locales use English. Seven actual brand colourways use independent seeded permutations. Execution IDs remain unchanged.

Checking: Controlled randomness, task-wide uniqueness and exhaustion, nested workers, resume/history stability, locale round trips, unsupported locales and legacy records. Run repository checks, Console tests and production build. Inspect 20px avatars on light and dark surfaces; disclose any limits of visual verification.

## factory · 2026-11-06 23:30
Recovered the clean item worktree and its existing commit 275013f5287b2bc530b1f46c3c5998573fe4c7eb from a stopped build. Claude Code verified it and needed no further changes. Only this item's commit is ahead of master; no prohibited paths changed.

Built task-wide random native-language names and seven local logo avatars, saved stable worker indices and approval-resume seed, and updated roster, detail and activity surfaces while retaining execution IDs and legacy readability.

Tests: Manager independently reran gofmt check, go vet ./... and go test ./... successfully; Console pnpm test passed 480/480 and pnpm build succeeded (existing chunk-size warning only).

Installs: none.

Visual verification: Claude Code reports static headless-browser checks at 1x and 2x with actual SVGs and approximate roster CSS, on light chips and the dark detail-panel surface. The Console currently has one light theme. The actual running-app roster was NOT visually checked; owner should inspect the 20px avatars there.

Pushed branch and moved new/ → review/. No merge or release.

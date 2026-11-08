---
branch: factory/FT31-console-topic-search
round: 1
---
# Console: a search box for topics

## lyric · 2026-11-08 23:17
Add a search box for topics in the nsh console's topic list, to find a topic by its title.

Where: the topic sidebar, `web/console-nsh/pages/chat/TopicSidebar.tsx`.

## factory · 2026-11-09 00:05
Moved from backlog to new at the owner’s request: “Move FT 31~34 to new”.

## factory · plan · 2026-11-09 00:36
Behaviour: a search field below the sidebar header filters loaded topics in the current view live by trimmed, case-insensitive displayed title (including fallback titles). Empty queries restore normal rows. Filter before grouping, omit empty groups and reveal matching collapsed groups without changing saved folds. Keep selection, loading/error handling and Load older intact; show localized no-matches feedback. Clear the query easily; do not persist it.

Scope: sidebar, controller filtering/grouping, translations and regression tests. No backend or message-content search, automatic pagination, new dependencies or unrelated redesign.

Decisions: search only loaded topics in the selected view and preserve hidden-topic rules. Load older extends searchable results. Reuse TextField and nsh reactive patterns.

Checking: case/whitespace/empty/fallback/no-match cases, collapsed groups and fold restoration, view filtering, stable selection, older pagination and phone behavior. Run Go formatting/vet/tests and nsh check/tests; report any missing visual inspection.

## factory · 2026-11-09 00:36
Built and pushed `6fc2f8ba` on `factory/FT31-console-topic-search`; moved new → review.

Implemented the search field on desktop and phone, title filtering before grouping, matching group expansion, localized empty results and older-topic guidance, and clear-button/Escape clearing. Query survives view changes but is not persisted; selection is unchanged. Group toggles and the no-tags hint are suppressed during search, preserving saved folds. Added three translation keys in English, Chinese and Japanese. Existing shared clear-button label remains English; shared UI component was not changed.

Tests: Go formatting, go vet ./... and go test ./... passed, independently verified by manager. Coder reports nsh check passed, all 277 nsh tests passed, nsh build passed without unknown-class warnings; after a comment-only edit, type checks and both topic test files (6 + 8 tests) passed again. Six new regression tests cover search behavior, folded groups, views, selection, pagination and phone layout. No forbidden paths changed; only this item's commit follows the start point.

Installs: none. UI appearance was not visually inspected: screenshot runtime was unavailable. Browser/desktop spacing and real Android keyboard behavior still need checking. Coder reported briefly making a temporary backup outside the run directory and deleting it immediately; no remaining stray file was reported.

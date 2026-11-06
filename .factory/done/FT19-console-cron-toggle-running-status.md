---
branch: factory/FT19-console-cron-toggle-running-status
round: 1
---
# Show aggregate cron running status on the topic toolbar toggle

## factory · 2026-11-06 16:32
Owner request: “factory new feature: when there are cron task is running, give a running status to the cron toggle button at the topic column topbar as well. the design should fit our design as well. do the status design wisely.”

Requirements:
- Show aggregate running status on the existing cron / TODO runs toggle in the topic column topbar whenever any cron-triggered topic task is running, including scheduled TODO runs. Show it regardless of the selected topic or whether the cron filter is active.
- Use authoritative run status and trigger metadata across the current Console scope, not just visible/filtered topics. Do not count queued or terminal tasks, or manual runs merely because they share a cron topic.
- Keep the toggle always visible, enabled, and clickable. Running is informational, not a disabled/loading button state. Preserve its recognizable icon, filter action, selected styling, focus, and pressed semantics.
- Design direction: reuse the existing topic running indicator's visual language and Console color, spacing, and motion tokens. Prefer a small, restrained activity marker attached to the existing icon with no toolbar resizing or layout shift. Do not replace the cron icon with a spinner, introduce a prominent new pill, or use flashing effects. Running and filter-selected states must remain independently distinguishable.
- Do not rely on color alone. Provide localized tooltip and accessible label text such as “TODO runs — 2 running”. Honor reduced-motion preferences with a static equivalent; avoid repetitive live announcements.
- Reuse existing status events/refresh mechanisms, not a separate high-frequency polling loop. Initialize correctly on page load and reconcile after reconnect. Duplicate/replayed events must not inflate counts. Clear the indicator when the last running cron task completes, fails, or is cancelled; a transient refresh failure is not evidence of completion.
- Leave topic-level statuses, unread behavior, cron execution, and notification policy unchanged. This is passive running status, not a completion notification.

Acceptance checks:
- Cover zero, one, and multiple running cron tasks. Finishing one of several preserves the indicator; finishing the last clears it.
- Verify all four running/idle and selected/unselected combinations. Filtering remains usable during execution.
- Runs outside the visible list still contribute; manual-only runs do not. Cover mixed manual/cron topics and duplicate events.
- Cover initial load, reconnect, refresh errors, successful completion, failure, and cancellation without false or stuck status.
- Inspect the actual UI at narrow/wide sidebar widths and in supported themes: no clipped marker, layout shift, or hover/focus/selected-style conflict. Check keyboard access, accessible labels, localization, and reduced motion.
- Add regression tests for aggregation and button-state rendering using the existing test setup.

Scope: read-only Console status presentation and minimum status plumbing needed for accuracy. No implementation in this intake change.

## factory · plan · 2026-11-06 18:00
Behaviour: Show an independent, localized running count and icon-attached marker on the always-enabled TODO runs toggle for strictly running scheduled cron tasks anywhere in the current endpoint. Successful full snapshots replace the count; errors retain it; stale replies are ignored; scope changes reset it and reconnect refreshes. Queued, manual and terminal tasks do not count. Preserve existing topic status, unread state and notifications.

Scope: Extend authoritative trigger/activity metadata minimally, reuse the existing activity tracker and polling, and update toolbar rendering, styles, locales, documentation and regression tests. No cron execution or notification policy changes.

Decisions: Count actual run trigger metadata, not topic naming. Keep the original icon, selected styling and pressed semantics. Reuse the hollow-square running marker without layout shift and use a static reduced-motion equivalent. No new polling or live announcements.

Checking: Backend aggregation across pages and mixed triggers, zero/one/multiple and terminal transitions; frontend replay, malformed/error/stale snapshots, endpoint switches, reconnect and four selected/running combinations; localization, accessibility attributes and reduced motion. Inspect narrow/wide UI where feasible.

## factory · 2026-11-06 18:00
Built in commits 5a4286e9 and 07af0e8e; pushed branch factory/FT19-console-cron-toggle-running-status. Moved new/ → review/.

Added recorded schedule/manual trigger distinction and per-topic cron_running activity counts, aggregated over the full endpoint snapshot. Added the toolbar marker and count labels in English, Chinese and Japanese, preserving filter interaction and existing status semantics.

Decisions: Run now is considered manual and excluded. Runs started before the new trigger metadata exists are not counted; newly scheduled runs are counted. Failed snapshots retain the previous count, duplicate snapshots cannot inflate it, and online reconnect refreshes immediately.

Verification: Manager independently passed gofmt cleanliness, go vet ./..., go test ./..., pnpm test (436/436) and pnpm build with an absolute throwaway HOME. No forbidden paths changed; both commits concern this item. Build reports a non-fatal bundle-size warning.

Installs: none beyond pinned console dependencies.

Visual checks: coder rendered the real header template with built CSS in headless Chrome at 220px and 310px, with normal/reduced motion, and checked stable bounds, hover and keyboard focus in the morph theme. This was not the live Console. Live runtime execution, phone layout and a real screen reader were not checked. A top-clipped focus ring appeared in the isolated test page; its source (existing styling versus harness) remains unverified and should be checked in review.

## factory · review · 2026-11-06 18:12
head: 07af0e8e86557890c531f851fd81236b47841f9d
verdict: pass

Codex reviewed all 15 changed files in origin/master...HEAD against the request and plan (base 6365a87dc643e8f9886950ced6eadc1dd478f3f9). No qualifying findings. Verified full-endpoint aggregation, trigger metadata, exclusion of manual/queued/terminal runs, filter interaction, labels, polling, reconnect, error retention and reduced motion.

Validation: Codex passed gofmt cleanliness, go vet ./..., go test ./... (156 test packages), pnpm test (436/436), and pnpm build. Build has a non-fatal bundle-size warning. Tests used an absolute throwaway HOME. Worktree remains clean; no source changes or commits were made during review.

Visual checks: header comparison at 230px and 310px found no clipped activity marker. The focus-ring top-edge clipping also occurs on base and is not introduced by this change. Full-page Chrome navigation timed out; live server end-to-end, phone layout and screen-reader checks remain unverified. Owner should inspect those before shipping.

Installs: restored pinned frontend dependencies and Go modules only; no unpinned installs. No linked GitHub issues or PRs. Moved review/ → ready/; not merged.

## factory · 2026-11-06 22:38
Shipped ready/ → done/ under the owner's authorization to merge currently ready items with matching passing reviews and no unresolved blockers. Reviewed branch head was verified unchanged immediately before push. No P0/P1 blockers; recorded P2 notes remain unchanged.

Merge: a1af44ce6eab1fa609a90fb33fdd8ed87f9f0677. Pushed master: fa4bab1b. Linked GitHub issues/PRs: none; nothing closed.

Combined validation passed with an absolute throwaway HOME: `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`; `pnpm test` (471 passed, zero failed); `pnpm build` (non-fatal large-chunk warning). No after_change commands configured. Restored only pinned frontend dependencies via `pnpm install --frozen-lockfile`; no unpinned installs.

FT19/FT20 integration conflicts were resolved by Codex, checked by the manager and included in their merge commits. Coder sandbox could not write Git metadata and restricted some tests; manager completed commits and independently passed the full combined checks. Live browser, mobile, keyboard, screen-reader and native-notification checks were not performed; prior review limitations still apply.

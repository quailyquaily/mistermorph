---
branch: factory/FT2-console-message-reactions
round: 0
---
# Console Web: real message_react on user message bubbles

## lyric · 2026-11-03 18:09

Make message_react produce a real message reaction in Console Web, similar to Telegram: attach the emoji to the user's message bubble rather than sending it as a separate text message.

### Acceptance criteria
- Calling message_react in a Console conversation attaches the requested emoji to the corresponding user message bubble; it does not create a standalone emoji message or assistant reply bubble.
- Resolve the target from the calling task's originating user message, or a validated explicit message identifier if supported. A later user message arriving during execution must not redirect the reaction to the newest bubble.
- Show the reaction adjacent to or beneath the target bubble, in a compact Telegram-like presentation without obscuring message content.
- Persist reactions and restore them when the conversation reloads; update the active conversation without requiring a reload.
- Retried delivery of the same reaction does not create duplicate badges. Define and document how repeated calls with a different emoji update or coexist with an existing reaction.
- Reject nonexistent or unauthorized targets with explicit errors. Restrict targets to the authorized conversation; do not silently fall back to sending plain emoji text.
- Update the Console-facing tool description and result semantics to describe actual reactions rather than ordinary text delivery. Preserve existing behavior for other supported channels.
- Add regression coverage for correct target selection, concurrent/new incoming messages, live rendering, reload persistence, duplicate delivery, and invalid or cross-conversation targets.

## factory · plan · 2026-11-03 19:59

**Behaviour:** Attach one reaction to the calling task's originating user bubble, not the newest message. Reject missing and cross-conversation targets. Persist and stream the reaction; repeated identical delivery is idempotent and a different emoji replaces the badge. Ordinary final text remains a separate reply when supplied.

**Scope:** Reuse the existing Console task journal, tool, WebSocket relay, polling and history rendering. Update Console API documentation and regression tests; leave other channels unchanged. Reuse the existing implementation rather than start another build.

**Decisions:** No explicit target identifiers are supported. One reaction per originating task; no new configuration. The keystore fixture fix is already identical to base.

**Checking:** Go formatting, vet and full tests; frontend regression tests and production build. Browser visual, live interaction and end-to-end agent checks require manual verification and an independent review job.

## factory · 2026-11-03 19:59

Reused and verified head `d18813f0ab2fe1f1d368905fd197a407dd2bd390`; pushed `factory/FT2-console-message-reactions` (remote was already up to date). Configured gate `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed with an absolute throwaway HOME and existing Go caches. Node v26.13.0 and pnpm 12.16.1 are available; existing frontend dependencies were reused without installation. `pnpm build` passed. Composer/reaction targeted tests passed 27/27. Full `pnpm test`: 306/308 passed; the two failures, “reasoning expands into the existing Markdown chat bubble” and “Skills sits after TODO in the navigation”, also fail on base `3682ff397104123d029a8c8728b2478506c928f6` (303/305 pass). These unrelated baseline failures were not changed.

A disposable merge with that base was conflict-free; the configured Go gate passed on merge commit `22aeab73d67f432925f1a1cdaf3629e0c2cbbf3d`. No feature was merged into master. Changed paths were checked against the forbidden-path list; no forbidden path changed. No new implementation or fix was needed, so recovery continued at Build step 5 without another coding-agent invocation.

The implementation and regression tests cover originating-target selection, later incoming messages, invalid/cross-conversation targets, persistence, idempotency/replacement, live updates and reload mapping. Actual browser layout and clipboard-independent conversation interactions were not checked. No authorized review has been recorded for this head; this item remains in review pending the separate review job, not ready. Full frontend-suite baseline failures remain visible for the owner.

## factory · review · 2026-11-03 22:35
head: d18813f0ab2fe1f1d368905fd197a407dd2bd390
verdict: fix
fix:
- [P1] internal/domainjournal/journal_test.go:260: baseline concurrent journal initialization intermittently fails with `begin migration: database is locked (SQLITE_BUSY)`; fix initialization lock handling while retaining the regression test. Example: initial head gate failed; current base reproduced 2 failures in 20 runs.
- [P1] web/console/src/core/chat-reasoning-bubble.test.mjs:25: baseline assertion rejects MarkdownContent throughout the status card although coder output uses it; scope the assertion to reasoning. Example: head and current base both fail with `true !== false`.
- [P1] web/console/src/core/skills-page.test.mjs:28: baseline navigation assertion requires Skills immediately after TODO despite Memories between them; reconcile the test with the intended navigation. Example: TODO → Memories → Skills fails the adjacency regex on head and base.

Codex reviewed all 19 changed files in `origin/master...HEAD`, merge base `1dbf971d4cc2d50d1671bb12b0c2ad072882f89d`, current base `172bd18d7f8b42bac97760cdf5be0c6bd9b3e05d`. No newly introduced defect was confirmed. The three findings above are pre-existing test failures, classified P1 by this run's test-failure rule, not attributed to FT2. Item stays in review/ for the owner to decide. Manager merge-tree check was conflict-free; no merge or implementation push was needed.

Validation: required gofmt/vet/full Go gate ultimately passed (155 passing packages, 17 without tests). Initial run had a journal failure and three environment-only Unix-socket path-length failures; shorter absolute throwaway HOME paths removed the latter. Full frontend suite: head 306/308 passed; current base 303/305 passed with the same two failures. Frontend production build passed; targeted reaction/composer tests 27/27 passed; diff whitespace check passed. Base journal repeated test passed 18/20. Tests used isolated environment and absolute throwaway HOME. Initial base snapshot lacked local module files; completing the repository archive enabled retesting.

Installs: none; reused existing Go caches, Node, pnpm and project dependencies. No source or lockfile changes, commits, fetches, pushes or gh calls by reviewer; manager verified clean worktree and unchanged head.

Residual risks: browser layout/mobile rendering, real-model reactions and remote disconnect/reconnect UX were not manually tested; some frontend regressions use source matching. Existing independent decision-route emoji text behavior does not call message_react and was outside the changed tool-path review. No linked GitHub issues or PRs were present in the header or owner's section, so no review comments were applicable.

## lyric · 2026-11-03 23:55

Fixed the three baseline failures from the review on this branch. None were FT2 defects.
- `9d9e8cfd`: the same two out-of-date frontend assertions as FT1 (coder replies use MarkdownContent in the status card since `0192ad29`; Memories sits between TODO and Skills since `32ea09a8`).
- `5f4dcebb`: the journal SQLITE_BUSY failure was a real race. While one connection switches a new database file to WAL, BEGIN can return SQLITE_BUSY at once instead of waiting out busy_timeout. `sqlitedb.Open` now retries the opening migration on SQLITE_BUSY for up to `BusyTimeout`. New test `TestConcurrentOpensOfNewFile` fails without the fix; the journal test passed 240/240 under parallel load.

Full gate and `pnpm test` (308 pass, 0 fail) pass on the new head. Review it again.

## factory · review · 2026-11-04 00:35
head: 5f4dcebb9c9105f88462049b3d5c45a69ec35375
verdict: pass

No findings. Codex reviewed the complete 23-file diff in origin/master...HEAD against the owner request, plan and follow-up, including SQLite opening retry and the frontend assertion fixes. Merge base: 1dbf971d4cc2d50d1671bb12b0c2ad072882f89d; current base: 172bd18d7f8b42bac97760cdf5be0c6bd9b3e05d. Coverage included originating-message binding, conversation authorization, argument validation, persistence and idempotent replacement, realtime event scope, frontend encoding, failure handling, SQLite retry/rollback and concurrent initialization. The manager's merge-tree check was conflict-free; no merge or implementation push was needed. Moved review/ → ready/ for owner approval.

Validation: configured gofmt/vet/full Go gate passed (155 passing packages, 17 without tests). Full pnpm test passed 308/308; pnpm build passed with the existing large-chunk warning. SQLite concurrent opening and journal concurrent import each passed 20 repeated runs; the former covered 1,000 new-file initialization rounds. git diff --check passed. Tests used isolated environment, absolute throwaway HOME and existing Go caches. Previous three baseline failures were not reproduced.

Installs: pnpm install --frozen-lockfile --ignore-scripts installed 83 locked Console dependencies. Reused Node 24.14.1 and cached pnpm 12.3.4; no Corepack downloads, install scripts, additional tools or sudo. Contact notified.

Residual risks: browser visual/mobile checks, real-model end-to-end reactions and remote disconnect/reconnect UX were not exercised. Some frontend regressions use source matching. Cancellation and lock-wait timeout boundaries were code-traced without dedicated fault injection; repeated concurrency tests do not prove races absent.

Reviewer made no source/lockfile changes, commits, merges, pushes, fetches or gh calls; manager verified clean worktree and unchanged head. No linked GitHub issues or PRs in the header or owner sections, so no review comments applicable. Removed the prior clean FT1 review worktree during routine recovery; no stopped changes needed preservation.

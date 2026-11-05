---
branch: factory/FT16-console-topic-unread-done-status
round: 1
---
# Console topic temporary done status until viewed

## factory · 2026-11-05 11:17
Requested by the owner: “topic 的 running status，如果从 running 到 done 需要加一个临时的 done 状态，用户进入该 topic 以后，该状态移除”

Add as a new item; this records the request, not an implementation.

Requirements:
- When a topic transitions from running to successfully done, replace its running indicator with a temporary done indicator so the user can identify completed topics they have not viewed.
- Clear that temporary indicator when the user enters the corresponding topic. Do not change the actual task completion status or history.
- If the topic is already actively visible when completion arrives, treat it as viewed; do not leave a stale done indicator. A background browser tab is not an active view.
- A subsequent run takes precedence over a previous done indicator; acknowledging an older completion must not clear a new running state.
- Do not mark failed or cancelled tasks as successfully done, and do not mark all historical completed topics as newly unread on initial load.
- Cover running-to-done, entering a completed topic, completion while actively viewing, background completion, and a subsequent run in regression tests.

Keep this separate from FT14 browser notifications: this item concerns the topic status indicator.

## factory · plan · 2026-11-05 12:45
Behaviour: Establish a first-observation completion baseline, then show a temporary done indicator for new successful completions not actively viewed. Entering a visible, focused topic acknowledges it; background windows and the mobile topic list do not. Running/pending takes precedence. Failed/cancelled tasks, empty/error responses and historical completions must not manufacture success.

Scope: Topic activity API, frontend tracker, ChatView lifecycle/status, styles, translations and regression tests. No browser notifications or persistent task history changes.

Decisions: Keep acknowledgements in session memory and identify successful completions by task identity and timestamp, not disappearance of running. Isolate endpoints and ignore stale requests.

Checking: Cover initial baseline, running-to-done, entry acknowledgement, active/background completion, failed/cancelled tasks, mobile visibility, endpoint switches and subsequent runs. Run the full Go gate, pnpm test and pnpm build; report any missing browser inspection.

## factory · 2026-11-05 12:45
Built and pushed f18ca9c3 (feat(console): show topic completion until viewed).
Added latest successful completion metadata to the activity API and a session-only acknowledgement tracker. Running/pending retains priority; viewing clears only the temporary indicator. Added done styling and localized labels.
Tests: manager independently passed gofmt check, go vet ./..., go test ./..., pnpm test (395 tests), and pnpm build with an absolute throwaway HOME.
Installs: no unpinned dependencies or tools installed.
Not checked: browser visual inspection; coder reported Chrome/CDP navigation timed out. Vite reports large chunks, but the build passes.
Moved new/ → review/ for review; not merged into master.

## factory · review · 2026-11-05 12:56
head: f18ca9c36aaf1357edfc0892365ee1c5f55ed480
verdict: pass
notes:
- [P2] web/console/src/views/ChatView.js:3000: Preserve acknowledgements across delayed activity responses. Example: A finishes while viewed, the user switches to B before the activity response arrives, and the delayed response marks A unread again because only the currently viewed topic is checked.
- [P2] web/console/src/core/topic-activity.js:62-64: Do not treat newly created topics after initial loading as historical baseline. Example: the initial full response is empty; another client creates and completes a topic between polls; its first successful completion is silently baselined and never shows done.
- [P2] web/console/src/core/topic-activity.js:46-48: Preserve unread state separately per endpoint. Example: A has an unread completion; switching to B and back to A clears its marker without entering the completed topic.

Validation: Codex reviewed all seven changed files in origin/master...HEAD and reproduced the three findings using the actual tracker, including the actual ChatView activity refresh function for the first finding. Required gofmt check, go vet ./..., go test ./..., pnpm test (395 tests), and pnpm build passed with an absolute throwaway HOME. No tracked code changes or commits made.
Installs: pinned dependencies restored only; no unpinned tools or dependency changes.
Residual risks: no real-browser visual or interaction check; build reports large chunks.
No P0/P1 findings; moved review/ → ready/ under the factory gate. P2 findings remain for owner consideration. Not merged into master.

## factory · 2026-11-05 15:09
Shipped to master in merge commit 4ea09a6d80d04c9467b96febdfe60b88afba89b2; release tag v0.3.78 pushed with master atomically.
Combined validation passed: gofmt check, go vet ./..., go test ./..., pnpm test (411/411), and pnpm build, with an absolute throwaway HOME. Build retains large-chunk warnings. No unpinned installs. No linked GitHub issues or PRs.
Owner explicitly requested “F16 一起合” after being informed of the three known P2 findings. Those findings remain unfixed. The ChatView import conflict was resolved preserving FT15 and FT16 behavior.
No additional real-browser validation in this ship run; prior browser coverage and limitations remain as recorded above. Moved ready/ → done/.

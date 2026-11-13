---
branch: factory/FT107-file-message-bubble-rounded-corners
round: 1
---
# Preserve rounded corners on message bubbles containing files

## factory · 2026-11-13 08:43
Owner report: "New UI issue: the bubble with a file, the border radius will be removed or covered for some reasons."

The supplied screenshot shows a message with text and a PNG attachment: parts of the bubble outline appear square or covered while other corners remain rounded. This is a visual defect; the exact CSS/painting cause has not been confirmed.

Expected behavior:
- Message bubbles containing attachments retain the intended rounded outer corners and a continuous, consistent border.
- Attachment backgrounds, wrappers, and interactive states must not paint over the bubble corners or extend beyond the rounded outline.
- Preserve text layout, attachment filename/type display, file opening/downloading, and the copy action.
- Verify text plus attachment, attachment-only, and multiple attachments on desktop and mobile, including long filenames and available themes.
- Add a regression check appropriate to the actual rendering cause and visually verify the rounded outline; do not assume the fix is simply adding overflow clipping if that would clip controls or focus indicators.

Scope: file-attachment bubble shape only. Command wrapping and activity prompt layout are tracked separately in FT106.

## factory · plan · 2026-11-13 11:44

Behaviour: User messages with text and files retain a continuous 14px outer border with the existing 2px top-right corner. File-row interactive fills remain inside the curve. Attachment-only messages omit the empty text slab; multiple and long filenames fit the bubble. Text-only and system messages, previews, download/error handling and copy keep existing behaviour.

Scope: Diagnose the actual painting cause and change only user-message bubble/file layout plus regression coverage. Activity command/prompt layout and unrelated received-file cards are excluded.

Decisions: Inspect nsh corner support before choosing a fix. Prefer one shared outer frame and inset rounded file rows over overflow clipping, preserving focus indicators, tooltips and copy. Preserve asymmetric corners and existing text-plus-file dimensions.

Checking: Cover text plus file, attachment-only, multiple long filenames, row reuse, system messages, preview selection and copy at desktop/mobile widths. Run nsh check, the full Console suite, gofmt, go vet and go test with throwaway HOME. Visually inspect actual web rendering, themes and interactive states; report unavailable native checks.

## factory · 2026-11-13 11:44

Built and pushed commit 864cd990 on factory/FT107-file-message-bubble-rounded-corners (start: 588ad961). The old split text/file frames and edge-to-edge square row fills caused the seam and covered bottom corners; nsh corner-radius support itself was not the cause. One outer frame now contains text and inset file rows with matching corner curves. No overflow clipping was added. Attachment-only messages no longer reserve an empty text slab. Added layout and interaction regression tests and a visual fixture. No backend/activity changes or forbidden paths changed.

Tests: gofmt and go vet passed. Required Go gate passed on retry, including a fresh go test -count=1 ./... run. Initial manager verification hit an unrelated pre-existing TestAttachmentInterrupted cleanup race (TempDir RemoveAll: directory not empty); reproduced on untouched base 5/60 runs and HEAD 1/60, left out of scope. nsh check passed; full suite on final committed source: 862 passed, 0 failed (19m 49s). Mutation checks against old layout failed as expected.

Visual verification: coder inspected actual Chrome rendering at 1280px and 390px for text-only, text plus file, file-only, multiple long filenames, system messages, hover/pressed/tooltip states and preview/copy interactions. Available light/dark palettes are identical. Native desktop and Android were not visually checked (no display server/device tooling). Screenshots remain ignored scratch artifacts.

Installs: none; no dependency manifests changed. Initial push needed per-command credential.useHttpPath=true; retry succeeded without changing global settings. Owner should inspect the rounded outline and file interactions on native clients before shipping.

## factory · review · 2026-11-13 12:10
head: 864cd9909ef48f62ff976d918edfaa0ac9a53ee4
verdict: pass
notes:
- Claude Code reviewed all four changed files on origin/master...HEAD against the request and plan. No qualifying findings. Worktree remained clean; no code changes or commits.
- Required gate passed: gofmt clean, go vet ./... and go test ./... (162 packages ok, gate exit=0). Tests used absolute throwaway HOME directories.
- Console validation passed: nsh check exit=0; nsh test --web-host tests/noHost.js: 862 passed, 0 failed (19m 53s), including all 11 attachment-bubble tests. Existing nsh 0.5.0 was used. Installs: none.
- Review was headless: no independent pixel/visual verification of corners, hover or pressed fills, and no native desktop or physical Android verification. Prior build records browser visual checks; owner should inspect native clients before shipping.
- No linked GitHub issue or PR was identified in this item. Moved review/ → ready/; not shipped.

## factory · 2026-11-13 19:24
Shipped to master. Merge commit: 0dd0e50be5b3f80708cce5943e5135f0f990da29. Release tag: v0.3.106.

Merged without conflicts or code fixes. Per-merge nsh check and full Console suite passed (884 tests, zero failures); changed tests passed. Final combined suite: 897/897; final configured gofmt/vet/go test gate passed. No unpinned installs or forbidden-path changes.

Claude Code prepared FT104–FT107 but was blocked by repeated Cloudflare HTTP 403 responses during testing; manager completed the remaining merge and shell checks directly. No fresh browser/native Android/native desktop visual verification in this ship run; remote CI completion unverified.

No linked GitHub issues or PRs identified; none closed. Branch retained (clean not configured). Moved ready/ → done/.

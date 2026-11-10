---
branch: factory/FT63-console-chat-scroll-jumps-during-running-task
round: 1
---
# Diagnose and fix chat scroll jumps while a task is running

## factory · 2026-11-10 09:43
Owner report:
> On the chatview, when the task is running, if I scroll at the view and stop at some position, the scrolltop will suddenly jump to another position. need to inspect the root reason and fix it.

Investigate and document the actual cause before implementing a fix; do not assume this is only an auto-scroll issue. Reproduce while streaming task output, manually scroll away from the bottom, then stop scrolling and observe subsequent updates. Inspect scroll writes, follow-bottom state, rerenders/remounts, browser scroll anchoring, and asynchronous content height changes as relevant.

Expected behavior and acceptance:
- Once the user scrolls away from the bottom, incoming task updates must preserve the reading position rather than unexpectedly moving the viewport.
- Preserve the visible content anchor when content above it changes height; an unchanged numeric scrollTop alone is not sufficient.
- Keep normal follow-bottom behavior when the user remains at the bottom; allow intentional return to the latest output to resume following.
- Verify streaming updates, tool/status updates, task completion, and topic switching on desktop and mobile. Preserve intentional initial positioning and navigation behavior.
- Add regression coverage for the confirmed root cause and record reproduction, diagnosis, fix, and checks performed. Explicitly note any browser/device checks not performed.

Registered for investigation and implementation; no root cause confirmed at intake.

## factory · plan · 2026-11-10 14:21

### Behaviour
Reproduce a running conversation with enough messages to scroll, scroll away from newest output, stop, and apply streamed text/tool/status/completion updates. Diagnose the actual viewport movement before choosing the fix. Preserve the visible message and its viewport offset when heights above it change, not merely numeric offset. Stay at newest output when already following; an intentional return to the bottom resumes following. Empty and first-load histories, loading older messages, errors and topic switches retain their intended navigation.

### Scope
Inspect ChatHistoryList's inverted virtualized List, its item measurement/identity/anchoring, controller scrollToIndex scheduling, and asynchronous row layout. Change only the confirmed cause and necessary integration/tests; document reproduction and diagnosis. No wholesale renderer replacement, unrelated UI polish, config changes or runtime upgrades without evidence.

### Decisions
The current list delegates anchoring/following to nsh 0.4.0 through an onLoadMoreAtStart listener; controller explicit scroll writes occur on initial load and send. These are suspects, not confirmed causes. Inspect actual runtime behavior and distinguish list corrections, stale index targets, rerenders and asynchronous measurements. Prefer the smallest cross-platform fix available within this repository, retaining virtualization and stable row identity. No assumed browser-only workaround. Document unavailable browser/device verification honestly.

### Checking
Add regression coverage for the reproduced cause, paused reading with content-height changes, follow-bottom/resume, streaming and tool/status/completion updates, older history and topic switches. Run the configured gofmt check, go vet ./..., go test ./..., plus nsh check and nsh test --web-host tests/noHost.js. Use absolute throwaway HOME for scripted tests, with existing tool/module cache paths explicitly retained if needed. Check desktop/mobile runtime where available, recording any unavailable physical/browser checks.

## factory · 2026-11-10 14:21

head: 04b36fee3d03163c1409689df9fc90853cead571
Built: stable message IDs now feed the virtualized List; reactive rows look up current data. Use chronological rather than inverted layout, conditional bottom-follow within 32pt, initial scrollToEnd, and an older-history header.
Diagnosis: nsh 0.4.0 compares List items by object identity, not keyExtractor. Streaming/status replacements and completion reloads invalidate measured rows and anchors. Coder reproduced completion jumps in headless Chrome on desktop and touch-phone layouts, including with browser anchoring disabled. Inverted layout also displaced reading position when content below grew, reproduced in headless regression tests. Full reproduction and evidence: docs/console/chat-scroll-anchoring.md.
Decisions: retain virtualization and row recycling; no runtime upgrade. Short conversations now align at the top, matching the former Vue layout, rather than above the composer; owner/reviewer should check this intentional layout difference.
Tests: manager independently passed configured gofmt check, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js (417 passed, 0 failed), with absolute throwaway HOME. New 14-case anchor regression suite covers desktop/phone streaming, status/completion, upstream height changes, older history, following/resuming, send and topic changes. Coder reports 7 cases fail on original implementation.
Installs: none; no manifest or lockfile changes.
UI checks: coder exercised headless Chrome desktop and touch-phone layouts with mock streaming, reading-anchor preservation, bottom following and topic switches. Not checked: native desktop app, Android device/emulator, Safari, Firefox, headed browser, real-model streaming. Manager independently ran automated suites, not interactive browser checks.
Verification: one item-focused commit from start c89e4e14; no forbidden paths changed; clean worktree; feature branch pushed. Round 1; moved new/ → review/.

## factory · review · 2026-11-10 14:36
head: 04b36fee3d03163c1409689df9fc90853cead571
verdict: pass
notes:
- [P2] web/console-nsh/components/chat/ChatHistoryList.tsx:137: chronological top pagination loses the visible reading anchor as prepended rows acquire measured heights. In a real-component headless phone-model probe, clicking Load earlier messages moved a-u1 from y=142pt to 326pt (184pt); base retained 142pt. Desktop second-page loading moved 70pt. Preserve the visible message ID and viewport offset across pagination and measurement; cover top-button loading and final-page button removal. Supplementary differential probes: HEAD 2 passed/4 failed; base 6 passed.
- Factory pass means no P0/P1 findings; the confirmed P2 pagination regression remains for owner consideration before shipping.
- Codex reviewed all seven changed files against origin/master c89e4e1430a6c50049aebb34cb8feb17ea22217c. Configured gofmt check, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js passed; frontend suite 417 passed, 0 failed. Tests used absolute throwaway HOME. No installs. Source worktree remains clean and head unchanged.
- Streaming, status/completion, following/resuming, topic switching, measured upstream height growth, short-history growth and empty-history send checks passed. Additional Chrome checks failed during page initialization on both HEAD and base, so this review obtained no valid browser result. Native desktop, Android device/emulator, Safari, Firefox, headed browser and real-model streaming were not checked.
- No linked GitHub issue or PR. Moved review/ → ready/ under the factory P0/P1 threshold; no code changed or shipped.

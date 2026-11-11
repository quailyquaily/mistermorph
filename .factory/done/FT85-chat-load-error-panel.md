---
branch: factory/FT85-chat-load-error-panel
round: 1
---
# Chat loading failure: centered error panel with refresh

## factory · 2026-11-11 13:08
Recorded from the owner’s UI fix request.

Request:
> On chat view, if loading failed, for example the network issues, show the error message panel in the view, with an icon, a text and a refresh button on it, all center aligned.

Acceptance criteria:
- When loading the chat view fails (including network errors), render an error panel inside the chat view rather than leaving a blank view or endless loading indicator.
- Show an error icon, readable error text, and a Refresh button as a centered group; center-align the contents.
- Refresh retries loading the current chat without requiring a full application restart. Prevent duplicate retries while loading; clear the error on success and keep a usable retry state on another failure.
- Preserve distinct loading, empty, successful, and error states; do not turn message-send failures into full-view load failures or discard already loaded messages unnecessarily.
- Add regression tests for failure, retry success, and repeated failure. Check layout and retry interaction in web and Android app; explicitly record any platform not actually checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 13:41
Behaviour: Show a centered icon, readable load error and Refresh on initial chat/history failure. Retry the current conversation and failed topic list, block duplicate in-flight retries, clear on success and remain retryable after repeated failure. Preserve existing messages on reload failure and keep send/action errors separate.

Scope: Chat loading controller, chat and topic sidebar rendering, reusable error panel, translations and regression tests. No unrelated backend or UI changes.

Decisions: Reuse nsh primitives and localized labels; use an inline panel when empty and compact strip when messages exist. Scope history errors to their conversation and preserve selected topic/draft on retry. No new dependencies.

Checking: Initial failure, retry success, repeated failure, topic switching, retained messages, separate send errors, mobile topic-list failure; nsh check and full suite; gofmt, go vet and go test. Check browser layout and record unavailable platform checks.

## factory · 2026-11-11 13:41
Built with Claude Code and pushed commit f9609268925d329a36fbbd617e70ca818e223a6d. Added centered chat load error panel and Refresh, compact retained-history/sidebar errors, scoped load state, guarded retry, English/Chinese/Japanese labels and eight regression tests. Moved new/ → review/.

Tests: required gofmt/vet/go test command independently passed. nsh check passed; full nsh suite: 619 passed, 0 failed. Focused regression suite: 8 passed. Coder checked network-failure/retry flows in headless Chrome at desktop and touch-phone sizes and inspected desktop error-panel and phone-strip screenshots.

Installs: none; reused existing browser tooling. Not checked: actual Android APK/device, native desktop window, Firefox, Safari or iOS. Android behavior was exercised only by the headless platform harness. Duplicate retries are guarded in code; a held-open request was not tested by the harness.

Initial branch push could not obtain credentials without a repository path; command-scoped credential.useHttpPath=true fixed the retry. No repository credential settings changed.

## factory · review · 2026-11-11 14:07
head: f9609268925d329a36fbbd617e70ca818e223a6d
verdict: pass
notes:
- [P2] web/console-nsh/pages/chat/chatController.ts:2632: retryChatLoad permits a history reload during sending, replacing optimistic messages. Verified example: topic-1 history loads while /topics returns 503; send “One more thing” with POST held open, then press the enabled Refresh strip button after /topics recovers. The sent message disappears and remains absent after task-2 is accepted. Guard retryChatLoad with sending, include sending in chatLoadBusy, and add a held-open-send regression test.

Reviewed by Claude Code against origin/master...HEAD. No P0/P1 findings; moved review/ → ready/ under the factory severity rule. The P2 above remains for owner attention before shipping. Branch merges cleanly with master. No source edits or commits made during review.

Validation: required gofmt/vet/go test command passed; nsh check passed; nsh test --web-host tests/noHost.js passed (619 tests, 0 failures). Additional throwaway probes verified the sending/Refresh defect and single-request guarding during a held-open retry. Tests used an isolated HOME. Installs: none.

Limits: no real-browser visual review, actual Android APK/device, native desktop, Firefox, Safari or iOS check in this review; Android was headless harness only. No linked GitHub issues or PRs in the item.

## factory · 2026-11-11 22:57
Shipped in owner-authorized batch FT80, FT85, FT86, FT91, FT92, FT93, merged in numeric order. Merge: 228488fc4dcec370017628dcf4bf97fc342e4179. Base master successfully pushed at d18743b3dfda935288e1a8fc4f739008ac14ed49 before this move. No tag created or pushed, per owner instruction.
Claude Code handled all fixes/review/conflicts; manager verified six merge parents, 11 item commits and 72 changed paths, with no forbidden paths or unrelated items. Targeted checks after this merge: 271/271 Console tests and nsh check passed; FT86 affected Go checks also passed. Final configured Go formatting/vet/tests passed (162 packages); nsh check and full Console suite passed 766/766. FT93 fix head 1666f8b4 was reviewed before shipment.
No linked GitHub issue/PR to close. Branch retained; no clean action requested. No unpinned installs or manifest changes; routine pinned TypeScript 7.0.2 cache restored. All scripted tests used absolute isolated HOME. No actual Android/emulator, iOS, native desktop or combined live-browser visual verification; existing nonblocking notes remain unchanged. Moved ready/ → done/ only after successful master push.

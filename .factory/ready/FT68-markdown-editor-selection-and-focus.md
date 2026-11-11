---
branch: factory/FT68-markdown-editor-selection-and-focus
round: 2
---
# Fix Markdown editor word selection and blank-area focus

## factory · 2026-11-10 14:14
Owner reports that the current Console Markdown editor cannot select a word on double-click, and that only the first line and lines containing text respond to focus clicks. Owner requests adding this UX issue to new.

Scope: the nsh Console Markdown editor wrapper (`web/console-nsh/components/shared/MarkdownEditor.tsx`) and its interaction with `nsh/base` Editor. Diagnose whether the failure belongs to our integration or the upstream editor before choosing the smallest reliable fix; do not replace the editor by default.

Investigation notes (hypotheses from prior source inspection, not browser-verified root causes):
- With `scrollBeyondLastLine={false}`, the text-line hit area may follow content height instead of filling the visible editor, leaving blank space below the last line unresponsive.
- nsh reportedly implements double-click word selection and triple-click line selection. Check click counts, event propagation, and subsequent selection resets rather than assuming missing support.
- Distinguish empty lines between paragraphs from blank space below the final line; the same cause may not explain both.

Acceptance criteria:
- Reproduce and compare a minimal plain Editor with our MarkdownEditor wrapper using identical content; record which layer causes each failure.
- Double-clicking a word selects it and preserves the selection for normal copy/replacement; ordinary single-click caret placement and drag selection continue working.
- Clicking an empty document, an empty line between text lines, the space to the right of text, or visible blank space below the last line focuses the editor and places the caret at a sensible corresponding position (document end below the final line).
- Verify short and multiline content, a scrolled document, and the current padding/layout with `scrollBeyondLastLine={false}`. Do not rely on enabling extra scroll space merely to hide the hit-area problem.
- Preserve editing, keyboard selection, Markdown preview switching, reference insertion, and touch focus behavior. Read-only editors must remain read-only.
- Add regression tests for the identified causes and exercise real browser pointer interactions; explicitly list any browser or Android host behavior not verified. If an upstream fix is required, document the dependency fix or minimal local workaround and its scope.

Registered only; implementation and browser verification have not started. Root cause remains unconfirmed.

## factory · 2026-11-10 16:52
Moved to backlog: this item contains only a factory intake section and no section signed by configured owner lyric. Non-owner sections are information only; there is no authorized implementation scope. Add an owner-signed request before returning it to new/. No implementation was attempted.

## factory · 2026-11-10 20:42
Owner explicitly confirms desktop reproduction and requests returning FT68 to new/: “FT68 我在桌面版也复现了。加到 new”. This is direct owner authorization in the current conversation to implement the existing FT68 scope; the earlier lack-of-authorization blocker is superseded by this request. Recorded by factory without impersonating an owner signature.

Move backlog/ → new/. Include the desktop host in reproduction and regression verification, alongside the plain Editor versus MarkdownEditor comparison. Desktop reproduction is owner-reported, not independently verified by factory; the exact failing interactions and root causes still require verification. No implementation was performed in this update.

## factory · 2026-11-10 21:34
Moved to backlog: the item has no section signed by configured owner lyric. Factory intake notes and reports of earlier owner authorization are information only under the current factory rules; they cannot authorize implementation scope. Please add an owner-signed request before returning this item to new/. No code was changed or coder invoked.

## lyric · 2026-11-10 21:35
这三个都是我发的，写我的名字

## factory · 2026-11-10 21:35
The owner explicitly confirmed authorship of FT68, FT71 and FT72 and requested recording their name. The lyric section above transcribes that confirmation verbatim from Telegram message 16060 (2026-11-10T12:35:42Z). It confirms the requests recorded earlier in these items, not independent verification of the factory investigation notes. Prior sections are preserved. Restored backlog/ → new/ after resolving the missing owner attribution; no implementation performed.

## factory · plan · 2026-11-10 22:55
Behaviour: preserve double-click word selection for copying/replacement and normal click/drag/keyboard selection. Focus and place the caret on empty documents, empty lines, right padding and below the final line; below-text clicks go to document end. Preserve preview, references, read-only and touch behaviour.
Scope: compare plain nsh/base Editor and MarkdownEditor with identical props, then apply the smallest reliable integration workaround. Keep scrollBeyondLastLine=false and existing layout; no editor replacement or unrelated UI changes.
Decisions: investigate click interception and hit geometry separately; prefer a narrow local workaround where nsh 0.4.0 exposes no direct fix.
Checking: regression tests, real Chrome pointer comparisons, short/empty/multiline/scrolled content; required Go and nsh checks. Explicitly disclose unverified desktop and Android hosts.

## factory · 2026-11-10 22:55
Built and pushed 8e7a5086 on factory/FT68-markdown-editor-selection-and-focus. Moved new/ → review/; round 1.

Claude Code compared plain Editor, matching-prop Editor, MarkdownEditor and AppMarkdownEditor in real Chrome. The global hover scrollbar theme creates an invisible scrollbar on the Editor's hidden caret input, intercepting the second click and drags from the caret. Separately, rows do not cover padding or below-text blank space with scrollBeyondLastLine=false. Interior empty lines and space right of text already worked in the reproduction.

Implemented a wrapper press handler and bounded caret-position probing through EditorRef.rangeBounds: blank-space caret placement, double/triple selection, Shift extension and mouse dragging; touch handles taps rather than scroll starts. Kept editor/layout/dependency version unchanged and documented the workaround in PORTING.md. Added 13 regression tests.

Tests: manager independently passed test -z "$(gofmt -l .)" && go vet ./... && go test ./..., nsh check, and nsh test --web-host tests/noHost.js (416/416). Scripted tests used absolute throwaway HOME. No unpinned installs. Only the five planned Console source/test/documentation files changed; no protected paths changed.

Claude Code reports real Chrome before/after tests on Persona and comparison fixtures, including copy/replacement, double/triple click, blank-area focus, scrolling, dragging, preview and read-only cases. Native desktop not verified: no isolated display/Xvfb; live user windows were not touched. Android devices, actual mobile browsers, Safari/Firefox and live TODO/Skills/Setup editors not verified. Chrome touch emulation verified blank-area taps; tapping text itself does not accept typing both before and after this change (pre-existing issue, not fixed).

Known limitations for review: blank-area-initiated drags do not auto-scroll beyond editor edges; rightmost 8pt is reserved for scrollbar even when absent. Browser verification is not native desktop verification.

Initial branch push lacked credential repository path; one retry with command-local credential.useHttpPath=true succeeded. No source issue/PR linked.

## factory · review · 2026-11-10 23:14
head: 8e7a508627d6cc66b9288fe6f5d40c8cab81afd9
verdict: pass
notes:
- [P2] web/console-nsh/components/shared/editorPresses.ts:185-195: dragAnchor survives a blank-area drag released outside the frame. A later drag entering from outside with the left button held resumes the stale selection; subsequent typing replaces unintended text. Verified in isolated Chrome: blank space below Zeta → drag outside and release → press outside and drag into Delta eps|ilon → type Q changes the suffix to Delta epsQ, removing ilon and Zeta. The native text-started drag control preserves text. Clear drag state on mouse leave or verified outside-release handling and add a regression test.

Claude Code reviewed all five changed files against origin/master and the request/plan. No P0/P1 findings; moved review/ → ready/ under the factory threshold. P2 remains for owner attention before shipping. Branch merges cleanly with the fetched master.

Validation: required gofmt, go vet ./..., go test ./... passed (EXIT=0); nsh check passed; nsh test --web-host tests/noHost.js passed 416/416. Scripted tests used throwaway HOME. Review worktree remained unchanged. No new installs. Isolated Chrome probes verified blank-area focus, word replacement, scrolled padding hit positions and touch tap/swipe behavior.

Not verified: native desktop app, Android devices, real mobile browsers, Safari/Firefox, live TODO/Skills/Setup editors, slow-host or very-long-line performance. Existing limitations: blank-area drags lack auto-scroll; the rightmost 8pt is reserved for a scrollbar; pre-existing Chrome-emulated touch text focus issue remains. No linked GitHub issue or PR to comment on.

## factory · 2026-11-11 10:14

Owner requested Claude Code fixes for the two previously identified P2 findings. Fixed on the existing branch, merged origin/master d122775a without conflicts. Fix commit a07dbd99; head a07dbd992376c36522d4bf5498aeb1cf62fee1a0. Blank-area drag state now ends on mouse leave; pending old drag updates are cancelled on a new press. Regression reproduces stale selection before fix and passes after. Isolated Chrome before/after confirms the reported unintended replacement is prevented, with ordinary inside and native text drags preserved.

Trade-off: a blank-area drag that leaves and re-enters while held stops at the exit position. Native desktop, Android, real mobile browsers, Safari/Firefox and live editor pages remain unverified. Claude Code reports gofmt cleanliness, go vet ./..., go test ./... (162 packages), nsh check, full nsh tests 550/550 passed with throwaway HOME. No installs. Manager inspected commits, source diff and clean worktree; did not independently rerun the full suites. Moved ready/ → review/ for fresh independent review; not shipped.

## factory · review · 2026-11-11 10:39
head: a07dbd992376c36522d4bf5498aeb1cf62fee1a0
verdict: pass

Claude Code independently reviewed origin/master d122775a...HEAD: all five changed files, request and plan, and the previous P2 fix. No qualifying findings. The branch merges cleanly with the fetched base. Moved review/ → ready/; not shipped.

The stale blank-area drag P2 is fixed. Regression tests fail twice with the pre-fix implementation and pass 13/13 at head. Isolated headless Chrome verified the previous outside-release/re-entry scenario no longer replaces unintended text, blank-to-text and inside drags, edge exit, double-click word replacement, and below-text focus. No page errors.

Validation reported by Claude Code: mandatory gofmt cleanliness, go vet ./..., go test ./... exited 0; nsh check exited 0; full nsh tests passed 550/550. Scripted tests used an absolute throwaway HOME. Manager verified unchanged worktree and matching remote head; did not independently rerun the suites. No installs; existing nsh 0.4.0 tool installation used for browser fixture build. No linked GitHub issue or PR.

Not verified: native desktop, Android, actual mobile browsers, Safari/Firefox, live TODO/Skills/Setup editors, and the case where the pointer is already over the editor when it appears (leave tracking depends on a recorded enter). Known trade-offs remain: blank-area drag stops on exit even if re-entered while held, no edge auto-scroll for blank-area drags, and rightmost 8pt reserved for scrollbar.

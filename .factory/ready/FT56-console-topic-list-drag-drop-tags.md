---
branch: factory/FT56-console-topic-list-drag-drop-tags
round: 1
---
# Fix drag-and-drop tag assignment in the topic list

## factory · 2026-11-10 08:42
Registered from the owner’s request.

User report: "Can't drag and drop at the tag topic list to assign tags to the topic item"

Restore drag-and-drop tag assignment in the tag/topic list. Inspect the existing UI to identify its intended drag source and drop target; make that interaction assign the intended tag to the intended topic. Give clear valid-drop feedback, persist the assignment, and refresh the affected list and topic tag display without a reload. Preserve other tags and avoid duplicate assignments. Cancelled or invalid drops must not change tags; report persistence failures.

Add regression coverage for a successful assignment, duplicate assignment, and invalid/cancelled drops. Preserve click/tap tag assignment on touch devices.

## factory · plan · 2026-11-10 10:01
Behaviour: drag a topic onto a named tag group in the tag view to append its tag. Highlight valid targets and clear feedback on completion/cancellation. Persist through the existing API, preserve unrelated tags, refresh list/topic display after success, show persistence errors. Empty lists, invalid targets and cancelled drops write nothing.

Scope: sidebar gesture wiring, controller tag assignment, targeted regression tests and framework notes; no unrelated redesign.

Decisions: additive assignment; duplicates are no-ops; Pinned and Untagged are not assignable; touch keeps scrolling and the existing tag picker. Use supported nsh gestures, not inert DOM drag attributes.

Checking: success and refresh, preserving tags, duplicate/invalid/cancelled drops, errors and touch fallback; repository gate and nsh checks/tests; desktop visual inspection.

## factory · 2026-11-10 10:01
Built and pushed 282f4b2f with Claude Code. Desktop tag-view topic rows now use PanResponder with a 6pt activation threshold, lifted-row feedback, valid-group outlines and target highlighting. Assignment preserves other tags, uses PUT /topics/{id}/tags, and refreshes after persistence. Escape, outside-list drops, duplicate tags, pseudo groups and unsupported topics save nothing. Touch scrolling and the Topic panel editor remain available. Missing tags in a save reply retain the submitted tags instead of wiping them.

Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`, `nsh check`, and `nsh test --web-host tests/noHost.js` (410 passed). Seven new regression tests. Coder additionally reported a warning-free nsh build and visual checks in headless Chrome against a real console server covering feedback, persistence, duplicate, Escape and outside-list drops. Scripted tests used throwaway HOME directories.

Installs: none. Limitations: no edge auto-scroll (mouse wheel works during drag); keyboard/screen-reader users retain the tag editor; Android/touch checked headlessly, not on physical hardware. No forbidden paths changed. Moved new/ → review/.

## factory · review · 2026-11-10 10:22
head: 282f4b2f3604a4d790fc50dc7cb086003b821b3c
verdict: pass
notes:
- [P2] web/console-nsh/pages/chat/topicDrag.ts:196: The lifted row does not compensate for list scrolling during a drag. With the pointer fixed at y=420, scrolling down 120 points leaves translateY at 20 and moves the row to y=300, while the drop target still follows the pointer. Record initial scroll offset and add its delta to the lifted row translation. Codex verified the source function with gesture/reactivity stubs; not reproduced in a real window.

Reviewed all five changed files in origin/master...HEAD with Codex. No P0/P1 findings; branch merges cleanly with master. Required gofmt/vet/Go tests passed; nsh check passed; nsh tests: 410 passed, 0 failed, including seven added regressions. Scripted tests used throwaway HOME directories. Installs: none. No code changes or commits by reviewer. Real browser, GPUI and touch hardware behavior was not verified in this review. Moved review/ → ready/; owner should inspect drag feedback while scrolling before shipping.

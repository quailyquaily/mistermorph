---
branch: factory/FT55-console-topic-panel-add-tags
round: 1
---
# Restore adding topic tags from the right-side panel

## factory · 2026-11-10 08:42
Registered from the owner’s request.

User report: "Can't click to add tags for the topic at the right panel."

Restore the right-side topic panel's add-tag interaction. Clicking/tapping the control should open the tag picker and allow assigning a tag to the current topic. Persist the assignment and update the panel and relevant topic lists without a reload. Preserve existing tags, prevent duplicate assignments, and surface failures rather than silently doing nothing.

Check pointer and touch interaction and add regression coverage for opening the picker and successfully assigning a tag.

## factory · plan · 2026-11-10 09:13
Behaviour: pressing the right-panel tag box focuses the field and opens known tags. Picking or typing persists tags and updates panel/list without reload. Empty known tags permit a first tag; duplicates preserve tags and pin state; failures display errors. Respect saving and tag limits.
Scope: existing TopicTagsEditor and topic tests; retain the API/save flow. No drag/drop or unrelated UI changes.
Decisions: reuse the current editor and investigate nsh focus/press handling instead of introducing a new picker.
Checking: opening, choosing, persistence/list refresh, first tag, duplicates, failures, phone sheet; console checks and repository tests. Report device limitations.

## factory · 2026-11-10 09:13
Built and pushed e13cf2a2. Touch presses were followed by emulated mouse events that stole focus. Defer field focus until after the press and remove tag-box/suggestion Tab stops, retaining keyboard selection. Existing save flow, pin preservation and errors remain intact.
Tests: nsh check passed; nsh build without warnings; nsh test --web-host tests/noHost.js: 369 passed, 0 failed. Repository gofmt/vet/go test passed; manager reran the required repository test successfully.
Added regression checks for opening, assignment and list refresh, first tag, duplicates, failure rollback and phone sheet. These headless tests also pass on the old editor: they do not reproduce browser post-touch mouse events. Coder additionally verified before/after using real console in Chrome with mouse and emulated touch at desktop/tablet/phone sizes; those browser scripts are not committed.
Not checked: physical phones/tablets, iOS Safari, desktop native app and Android native app. Deferred focus may affect iOS software-keyboard activation; owner/reviewer should check this on device.
Installs: none.
Recovery: preserved a pre-existing unpushed board commit in a refs/factory/stopped recovery ref and reset the local board to the remote before starting; its unrelated changes were not published.
Moved new/ → review/ for independent review.

## factory · review · 2026-11-10 09:20
head: e13cf2a299d9cb2bae265f6895fd59c47f4acb33
verdict: pass
notes:
- Independent Codex review of origin/master...HEAD found no verified introduced defects. Branch merges cleanly with current base.
- Required gofmt, go vet ./... and go test ./... passed. Console nsh check passed; nsh test --web-host tests/noHost.js: 369 passed, 0 failed. Scripted tests used a throwaway HOME.
- Chrome mouse and emulated tablet/phone touch checks passed for picker opening, assignment, save request, list refresh, tag/pin preservation, duplicates, failure rollback/error display and keyboard selection/deletion. API responses were mocked.
- Limitations: browser checks also opened the picker on the old editor, so the original focus failure was not independently reproduced. Physical devices, iOS software keyboard and native clients remain unverified.
- Installs: none. No tracked code changes. Moved review/ → ready/; awaiting owner approval before shipping.

## factory · 2026-11-10 23:38
Merged into master at 75541ce7e6fc21d47b71aab00b90e1da27b693b4. Released in v0.3.93; base and annotated tag pushed atomically. Moved ready/ → done/.

Validation on the final integrated base: manager gofmt cleanliness, go vet ./... and go test ./... passed; nsh 0.4.0 check passed and full console suite passed (524/524). Tests used a throwaway HOME. The first final console run exceeded the tool timeout and was confirmed stopped before the successful rerun. after_change is empty. No forbidden paths changed.

Linked issues/PRs: none (no source or owner closure links); nothing to close. Installs: none. Native desktop windows, real Android/device rendering, Windows/macOS and real IME/accessibility were not verified during ship; existing review notes remain.

---
branch: factory/FT114-contacts-tabs-recency-sort-and-todo-calendar-button
round: 2
---
# Contacts: Agents/Humans tabs and recent-interaction sorting; circular Todo calendar toggle

## factory · 2026-11-14 07:03
Owner request from Console:

> The contacts page, use a tab like topics page to distinguish the agents and human contacts.
> And sort them by last interaction by default.
> And the calendar toggle button on the Todo page should be circle.
> Add it to new/

### Required behavior
- Split the Contacts page into Agents and Humans tabs, using icon-only tab buttons (an agent icon and a human/person icon), with no visible text labels. Retain the Topics page's tab layout and interaction conventions, with a clear selected state. Give each button an accessible name (Agents or Humans), keyboard support, and a usable touch target. Each tab shows only contacts of that kind, retaining existing contact actions and applicable filters.
- Default to last-interaction order, newest first, within each tab. Use actual recorded interaction timestamps rather than contact creation or profile-update times. Contacts without an interaction timestamp go after dated contacts; use a deterministic secondary order for ties and undated contacts.
- Keep the active tab's ordering correct after interaction data refreshes. Handle empty tabs and missing timestamps without errors.
- Make the Todo page's calendar toggle button circular, with equal width and height, centered icon, and a fully rounded border in both active and inactive states. Preserve its toggle behavior, accessible label, focus indicator, and usable touch target.

### Acceptance checks
- Agents and Humans are separated by icon-only tab buttons on desktop and mobile, with no visible text labels, distinct icons, accessible names, and a clear selected state; switching tabs does not mix contact kinds or break contact actions.
- Initial contact lists are sorted newest-interaction first, including correct handling of ties, no-interaction contacts, and refreshed interaction timestamps.
- Empty contact kinds display an appropriate empty state.
- The Todo calendar toggle remains circular at supported viewport sizes in both states, with no icon clipping or layout overflow; mouse, touch, and keyboard toggling still work.
- Add or update regression tests for icon-only tabs and their accessible names, contact-kind filtering, default ordering and missing timestamps, plus the calendar toggle's shape and behavior. State any browser checks that could not be performed.

## factory · 2026-11-14 07:05
Owner clarification: Agents/Humans tabs must use icon buttons, with no visible labels.

Status: requested only; not implemented yet.

## factory · plan · 2026-11-14 14:49
Behaviour: Humans is the default icon-only tab; Agents is separate, with accessible names, selection and keyboard navigation. Preserve filter text, close a selected contact/editor of the other kind when switching, and follow a contact into its new kind after YAML save. Sort by actual valid last_interaction_at descending, missing/invalid/zero dates last, contact_id as deterministic tie-break; refresh re-sorts. Empty kinds have localized messages. Both TODO views use the same circular calendar toggle.

Scope: Contacts head, list/helpers, localized empty states and tests; shared TODO view toggle and calendar-head alignment, regression tests and English PORTING note. No new APIs, fabricated interaction dates, unrelated production behavior or dependency changes.

Decisions: Reuse Topics-style icon presentation with nsh/base Tabs/Tab for arrow/Home/End navigation and one tab stop. Keep absent contact kind normalized to human. Parse RFC3339 consistently across QuickJS and Chrome. Reuse list-view CircleButton in the calendar; align head padding so the control does not move on toggle.

Checking: Cover icon-only labels/keyboard/touch, kind/filter/action/empty states, timestamp ties/missing/invalid/refreshed ordering, and equal circle geometry/toggling. Run configured Go gate, nsh 0.5.0 check and full Console suite with absolute throwaway HOME. Inspect headless Chrome at desktop/mobile widths; record real-device gaps.

## factory · 2026-11-14 14:49
Built and pushed 8b1008d1 and 2ea6eb1f on factory/FT114-contacts-tabs-recency-sort-and-todo-calendar-button, based on 75eec416. Moved new/ → review/, round 1.

Implemented icon-only Humans/Agents tabs with accessible names, selected state, keyboard navigation and 44pt phone targets; newest recorded interaction ordering with deterministic ties and safe absent/invalid values; reload and editor-kind transitions; localized empty states. Shared 38pt circular TODO calendar toggle in both list/calendar views, retaining alignment and toggle behavior. Added 22 regression tests and updated existing Contacts coverage. Calendar Add button also reuses the round control to preserve head alignment; no unrelated production changes.

Installs: none; used existing repository-required nsh 0.5.0, no dependency/lockfile changes. Only the two item commits are on the branch; no forbidden paths changed. Manager independently verified configured gofmt cleanliness, go vet ./... and go test ./...: all pass. nsh check passes. Full nsh suite failed twice, each 939 tests: 938 passed, 1 failed. Retry failure: `tests/chat-composer-drum.test.tsx:43:29 android: expected 0 to be 1`. All changed/new Contacts and TODO tests pass. Unchanged base drum file failed 7/10 isolated repeats (Android 5, Linux 2); HEAD failed 5/10 (Android 4, Linux 2, one run both). Earlier baseline investigation reproduced the same flake. This is a pre-existing required-suite failure, deliberately not masked by unrelated code/test edits; full suite is NOT green and review must see it.

UI checked in headless Chrome at 1280/390 widths: tab roles/names/selection, focus/arrow cycling, 44pt edge taps, row refresh ordering, circular geometry and calendar-toggle alignment/Enter behavior. Not checked: real Android hardware/emulator, iOS, or GPUI desktop window. Owner should check native touch/keyboard and real-device appearance. No linked GitHub issue/PR in request.

## factory · review · 2026-11-14 15:24
head: 2ea6eb1f6900520a64eb00699ca2a8860eae8f6f
verdict: fix
fix:
- [P1] web/console-nsh/tests/chat-composer-drum.test.tsx:53: Required full Console suite failed: linux typing-turns-drum-to-Send assertion, expected 0 to be 1; 938/939 passed. Restore a green required suite before advancing. This is a gate blocker, NOT a defect introduced by FT114: independent baseline copies reproduced failures in 2/5 base runs and 1/5 HEAD runs. Do not silently weaken the gate or make unrelated production changes; coordinate the existing flaky test fix separately.
notes:
- [P3] web/console-nsh/tests/contact-kind-tabs.test.tsx:64: The plan calls for keyboard regression coverage, but committed tests use app.press only. Add Tab/Right/Left/End selection assertions; a throwaway probe confirmed current keyboard behavior works. This is a coverage gap, not a verified runtime defect.
- Claude Code reviewed all 15 changed files against origin/master...HEAD, including contact load/save/filter/selection paths, timestamp/backend contracts, nsh Tabs and shared TODO control. No introduced runtime defects found. No conflicts with master; no code changes or commits made.
- Validation: configured gofmt/vet/go-test gate passed (163 packages ok); nsh 0.5.0 check passed. Full nsh suite: 939 tests, 938 passed, 1 failed as above. All 38 tests in new/changed Contacts/TODO files passed. Separate keyboard probe passed. Scripted tests used an absolute throwaway HOME.
- Installs: none. Native Android/iOS/GPUI appearance and focus rings not checked. Switching tabs discards unsaved YAML edits as accepted in the plan; owner should consider that behavior.
- Round 1/3: review/ → new/ for the next fix round. No linked GitHub issue or PR; no GitHub comments required.

## factory · 2026-11-14 21:17
Fix round 2, done by Claude Code in the owner's session at the owner's request; the owner then asked for the move to review/. Pushed 5e6496ffe0870a82995de2a8303b5facb18513d5 on the branch: a merge of master (2e37a15f), no other commit. Moved new/ → review/ (round 2).

The round 1 finding: master no longer has tests/chat-composer-drum.test.tsx (2e37a15f). It counted the drum right after a keypress while the turn lasts 240 ms of real time, so it failed whenever the machine was busy. The merge brings that removal here.

Conflict: master made Contacts a library of cards with the contact in a panel (45c12569), and web/console-nsh/pages/contacts/ContactsPage.tsx conflicted in 7 places. Resolved: the Humans and Agents tabs sit in the library's head; the library shows the tab's contacts, latest interaction first, through master's filter motion; leaving a tab closes the other kind's panel and editor, and takes the arrow keys off its card (new here). Switching tabs has no motion of its own.

Tests changed with it: three in contacts-kinds.test.tsx read the panel (no "No contact selected" page; the kind line in capitals); two of master's in contacts.test.tsx use people only for the panel and the arrow keys, an agent being on its own tab.

Installs: none.

Tests on this head: gofmt, go vet ./... and go test ./... passed. `nsh check` passed. Console suite with web/console-nsh/scripts/test.sh (one `nsh test` per file, several at a time): 111 files, 0 failed. The serial `nsh test --web-host tests/noHost.js` was not run on this head.

Not checked: nobody has looked at the tabs in the library's head, in a browser or on a device, on a desktop or a phone. The review's P3 note (keyboard coverage for the tabs) is not addressed.

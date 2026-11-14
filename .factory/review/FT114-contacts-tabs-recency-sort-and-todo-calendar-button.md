---
branch: factory/FT114-contacts-tabs-recency-sort-and-todo-calendar-button
round: 1
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
